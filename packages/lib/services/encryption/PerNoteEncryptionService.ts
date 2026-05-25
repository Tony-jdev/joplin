import EncryptionService, { EncryptionMethod } from '../e2ee/EncryptionService';
import { NoteEntity, ResourceEntity } from '../database/types';
import Note from '../../models/Note';
import NoteResource from '../../models/NoteResource';
import Resource from '../../models/Resource';
import { getEncryptionEnabled } from '../synchronizer/syncInfoUtils';

// Metadata stored unencrypted alongside an encrypted note body so any
// future client can detect how to decrypt it.
export interface PerNoteEncryptionMetadata {
	version: number;
	method: EncryptionMethod;
}

export interface PerNoteResourceEncryptionMetadata {
	version: number;
	method: EncryptionMethod;
}

const METADATA_VERSION = 1;

// Maximum resource blob size for StringV1 whole-file encryption.
export const MAX_PER_NOTE_RESOURCE_BYTES = 15 * 1024 * 1024;

// Store the session password directly on `window` so ALL code in the renderer
// process shares the same value regardless of how esbuild resolved this module.
const WINDOW_KEY = '__joplinPerNoteEncPwd';
const WINDOW_EXP_KEY = '__joplinPerNoteEncExp';
const WINDOW_LAST_UNLOCKED_KEY = '__joplinPerNoteEncLastUnlocked';
const WINDOW_UNLOCKED_RESOURCES_KEY = '__joplinPerNoteUnlockedResourceIds';
const CACHE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global_ = (typeof window !== 'undefined' ? window : global) as any;

const unlockedResourceIds_ = (): Set<string> => {
	if (!global_[WINDOW_UNLOCKED_RESOURCES_KEY]) {
		global_[WINDOW_UNLOCKED_RESOURCES_KEY] = new Set<string>();
	}
	return global_[WINDOW_UNLOCKED_RESOURCES_KEY] as Set<string>;
};

const touchCache_ = (password: string) => {
	global_[WINDOW_KEY] = password;
	if (global_[WINDOW_EXP_KEY]) clearTimeout(global_[WINDOW_EXP_KEY]);
	global_[WINDOW_EXP_KEY] = setTimeout(() => {
		void clearPasswordCache();
	}, CACHE_TIMEOUT_MS);
};

// Clears the in-memory session cache (e.g. on app lock or user request).
export const clearPasswordCache = async () => {
	const password = getSessionPassword();
	if (password) {
		await reencryptAllSessionResources(password);
	}
	global_[WINDOW_KEY] = null;
	global_[WINDOW_LAST_UNLOCKED_KEY] = null;
	global_[WINDOW_UNLOCKED_RESOURCES_KEY] = new Set<string>();
	if (global_[WINDOW_EXP_KEY]) {
		clearTimeout(global_[WINDOW_EXP_KEY]);
		global_[WINDOW_EXP_KEY] = null;
	}
};

// Returns the last password entered this session, or null if none yet.
export const getSessionPassword = (): string | null => {
	const pw = global_[WINDOW_KEY] as string | null | undefined;
	return pw ?? null;
};

// Records the most recently used password for the current session.
export const setSessionPassword = (password: string): void => {
	touchCache_(password);
};

// Returns the ID of the last unlocked note, or null if none.
export const getLastUnlockedNoteId = (): string | null => {
	const id = global_[WINDOW_LAST_UNLOCKED_KEY] as string | null | undefined;
	return id ?? null;
};

// Records the ID of the most recently unlocked note.
export const setLastUnlockedNoteId = (noteId: string): void => {
	global_[WINDOW_LAST_UNLOCKED_KEY] = noteId;
};

export const isNoteEncrypted = (note: NoteEntity): boolean => {
	return !!note.is_encrypted;
};

export const isResourcePerNoteEncrypted = (resource: ResourceEntity): boolean => {
	return !!resource.is_per_note_encrypted;
};

export const getNoteEncryptionInfo = (note: NoteEntity): PerNoteEncryptionMetadata | null => {
	if (!isNoteEncrypted(note) || !note.encrypted_metadata) return null;
	try {
		return JSON.parse(note.encrypted_metadata) as PerNoteEncryptionMetadata;
	} catch {
		return null;
	}
};

export const getResourceEncryptionInfo = (resource: ResourceEntity): PerNoteResourceEncryptionMetadata | null => {
	if (!isResourcePerNoteEncrypted(resource) || !resource.per_note_encrypted_metadata) return null;
	try {
		return JSON.parse(resource.per_note_encrypted_metadata) as PerNoteResourceEncryptionMetadata;
	} catch {
		return null;
	}
};

const ensureResourcePlaintextForPerNoteEncrypt_ = async (resource: ResourceEntity): Promise<ResourceEntity> => {
	let item = { ...resource };

	if (item.encryption_applied || item.encryption_cipher_text) {
		if (!getEncryptionEnabled()) {
			throw new Error('This attachment is protected by end-to-end encryption. Enable and unlock E2EE before encrypting the note.');
		}
		item = await Resource.decrypt(item);
	}

	if (item.encryption_blob_encrypted) {
		if (!getEncryptionEnabled()) {
			throw new Error('This attachment is protected by end-to-end encryption. Enable and unlock E2EE before encrypting the note.');
		}
		item = await Resource.decrypt(item);
	}

	return item;
};

export const ensureExclusiveResourcesForNote = async (note: NoteEntity): Promise<{ body: string; resourceIds: string[] }> => {
	if (!note.id) throw new Error('Note must be saved before encrypting resources');

	let body = note.body || '';

	const resourceIds = await Note.linkedResourceIds(body);
	for (const resourceId of resourceIds) {
		const associatedNoteIds = await NoteResource.associatedNoteIds(resourceId);
		const usedElsewhere = associatedNoteIds.some(noteId => noteId !== note.id);
		if (usedElsewhere || (associatedNoteIds.length > 1 && associatedNoteIds.includes(note.id))) {
			const newResource = await Resource.duplicateResource(resourceId);
			const regex = new RegExp(resourceId, 'gi');
			body = body.replace(regex, newResource.id);
		}
	}

	return {
		body,
		resourceIds: await Note.linkedResourceIds(body),
	};
};

export const encryptResourceBlob = async (resource: ResourceEntity, password: string): Promise<ResourceEntity> => {
	const method = EncryptionMethod.StringV1;
	const plainResource = await ensureResourcePlaintextForPerNoteEncrypt_(resource);

	const plainPath = Resource.fullPath(plainResource);
	const perNotePath = Resource.perNoteEncryptedPath(plainResource);

	if (!(await Resource.fsDriver().exists(plainPath))) {
		if (await Resource.fsDriver().exists(perNotePath)) {
			return plainResource;
		}
		throw new Error(`Attachment file not found for resource ${resource.id}`);
	}

	const fileStat = await Resource.fsDriver().stat(plainPath);
	if (fileStat.size > MAX_PER_NOTE_RESOURCE_BYTES) {
		throw new Error(`Attachment "${plainResource.title || plainResource.id}" is too large to encrypt with a note password (max ${MAX_PER_NOTE_RESOURCE_BYTES / (1024 * 1024)} MB).`);
	}

	const plainBase64 = await Resource.fsDriver().readFile(plainPath, 'base64');
	const cipherText = await EncryptionService.instance().encrypt(method, password, plainBase64);

	await Resource.fsDriver().unlink(perNotePath);
	await Resource.fsDriver().writeFile(perNotePath, cipherText, 'utf8');

	try {
		await Resource.fsDriver().unlink(plainPath);
	} catch {
		// Plain path may already be absent.
	}

	unlockedResourceIds_().delete(resource.id);

	const metadata: PerNoteResourceEncryptionMetadata = {
		version: METADATA_VERSION,
		method,
	};

	const saved = await Resource.save({
		id: resource.id,
		is_per_note_encrypted: 1,
		per_note_encrypted_metadata: JSON.stringify(metadata),
	}, { autoTimestamp: false });

	touchCache_(password);

	return saved;
};

export const decryptResourceBlobToPlaintext = async (resource: ResourceEntity, password: string): Promise<ResourceEntity> => {
	if (!isResourcePerNoteEncrypted(resource)) return { ...resource };

	const info = getResourceEncryptionInfo(resource);
	if (!info) throw new Error('Encrypted attachment has missing or corrupted metadata');

	const perNotePath = Resource.perNoteEncryptedPath(resource);
	if (!(await Resource.fsDriver().exists(perNotePath))) {
		const plainPath = Resource.fullPath(resource);
		if (await Resource.fsDriver().exists(plainPath)) {
			unlockedResourceIds_().add(resource.id);
			return resource;
		}
		throw new Error(`Encrypted attachment file not found for resource ${resource.id}`);
	}

	let plainBase64: string;
	try {
		const cipherText = await Resource.fsDriver().readFile(perNotePath, 'utf8');
		plainBase64 = await EncryptionService.instance().decrypt(info.method, password, cipherText);
	} catch (error) {
		const message = (error as Error).message || '';
		if (message.includes('ccm') || message.includes('tag') || message.includes('decrypt') || message.includes('corrupt')) {
			throw new Error('Incorrect password or corrupted attachment');
		}
		throw error;
	}

	const plainPath = Resource.fullPath(resource);
	await Resource.fsDriver().writeFile(plainPath, plainBase64, 'base64');

	unlockedResourceIds_().add(resource.id);
	touchCache_(password);

	return resource;
};

export const reencryptResourceBlobFromPlaintext = async (resource: ResourceEntity, password: string): Promise<ResourceEntity> => {
	if (!isResourcePerNoteEncrypted(resource)) return { ...resource };

	const plainPath = Resource.fullPath(resource);
	if (!(await Resource.fsDriver().exists(plainPath))) {
		unlockedResourceIds_().delete(resource.id);
		return resource;
	}

	return encryptResourceBlob(resource, password);
};

export const permanentlyDecryptResourceBlob = async (resource: ResourceEntity, password: string): Promise<ResourceEntity> => {
	if (!isResourcePerNoteEncrypted(resource)) return { ...resource };

	await decryptResourceBlobToPlaintext(resource, password);

	const perNotePath = Resource.perNoteEncryptedPath(resource);
	if (await Resource.fsDriver().exists(perNotePath)) {
		await Resource.fsDriver().unlink(perNotePath);
	}

	unlockedResourceIds_().delete(resource.id);

	return Resource.save({
		id: resource.id,
		is_per_note_encrypted: 0,
		per_note_encrypted_metadata: '',
	}, { autoTimestamp: false });
};

export const encryptLinkedResourcesForNote = async (note: NoteEntity, password: string, resourceIds: string[] = null): Promise<void> => {
	const ids = resourceIds ?? await Note.linkedResourceIds(note.body || '');
	for (const resourceId of ids) {
		const resource = await Resource.load(resourceId);
		if (!resource) continue;
		if (isResourcePerNoteEncrypted(resource)) continue;
		await encryptResourceBlob(resource, password);
	}
};

export const ensureResourcesDecryptedForNote = async (noteId: string, password: string, decryptedBody: string): Promise<void> => {
	const resourceIds = await Note.linkedResourceIds(decryptedBody);
	for (const resourceId of resourceIds) {
		const resource = await Resource.load(resourceId);
		if (!resource || !isResourcePerNoteEncrypted(resource)) continue;
		await decryptResourceBlobToPlaintext(resource, password);
	}
	setLastUnlockedNoteId(noteId);
};

export const reencryptAllSessionResources = async (password: string): Promise<void> => {
	const ids = Array.from(unlockedResourceIds_());
	for (const resourceId of ids) {
		const resource = await Resource.load(resourceId);
		if (!resource || !isResourcePerNoteEncrypted(resource)) continue;
		await reencryptResourceBlobFromPlaintext(resource, password);
	}
	unlockedResourceIds_().clear();
};

export const permanentlyDecryptLinkedResourcesForNote = async (decryptedBody: string, password: string): Promise<void> => {
	const resourceIds = await Note.linkedResourceIds(decryptedBody);
	for (const resourceId of resourceIds) {
		const resource = await Resource.load(resourceId);
		if (!resource || !isResourcePerNoteEncrypted(resource)) continue;
		await permanentlyDecryptResourceBlob(resource, password);
	}
};

export const encryptNewlyAttachedResourcesIfNeeded = async (note: NoteEntity, resourceIds: string[]): Promise<void> => {
	if (!note.is_encrypted) return;
	const password = getSessionPassword();
	if (!password) return;

	for (const resourceId of resourceIds) {
		const resource = await Resource.load(resourceId);
		if (!resource || isResourcePerNoteEncrypted(resource)) continue;
		await encryptResourceBlob(resource, password);
	}
};

// Encrypts only the note body. The title is left plaintext so notes remain
// identifiable in the note list. The caller is responsible for saving the returned entity.
export const encryptNote = async (note: NoteEntity, password: string): Promise<NoteEntity> => {
	const method = EncryptionMethod.StringV1;
	const cipherText = await EncryptionService.instance().encrypt(method, password, note.body || '');

	touchCache_(password);

	const metadata: PerNoteEncryptionMetadata = {
		version: METADATA_VERSION,
		method,
	};

	return {
		...note,
		body: cipherText,
		is_encrypted: 1,
		encrypted_metadata: JSON.stringify(metadata),
	};
};

// Decrypts the body of an encrypted note in memory. is_encrypted remains 1.
// Supports the legacy format (body was JSON-encoded {title, body}) transparently.
export const decryptNote = async (note: NoteEntity, password: string): Promise<NoteEntity> => {
	if (!isNoteEncrypted(note)) {
		return { ...note };
	}

	const info = getNoteEncryptionInfo(note);
	if (!info) throw new Error('Encrypted note has missing or corrupted metadata');

	let plainText: string;
	try {
		plainText = await EncryptionService.instance().decrypt(info.method, password, note.body || '');
	} catch (error) {
		const message = (error as Error).message || '';
		if (message.includes('ccm') || message.includes('tag') || message.includes('decrypt') || message.includes('corrupt')) {
			throw new Error('Incorrect password or corrupted note content');
		}
		throw error;
	}

	touchCache_(password);

	let title = note.title || '';
	let body = plainText;
	try {
		const parsed = JSON.parse(plainText) as { title?: string; body?: string };
		if (parsed && typeof parsed.body === 'string') {
			body = parsed.body;
			if (typeof parsed.title === 'string') title = parsed.title;
		}
	} catch {
		// Not JSON — new format, plainText is the body directly.
	}

	return {
		...note,
		title,
		body,
	};
};

// Permanently removes per-note encryption. The caller must save the returned entity.
export const permanentlyDecryptNote = async (note: NoteEntity, password: string): Promise<NoteEntity> => {
	const decrypted = await decryptNote(note, password);
	await permanentlyDecryptLinkedResourcesForNote(decrypted.body || '', password);
	return {
		...decrypted,
		is_encrypted: 0,
		encrypted_metadata: '',
	};
};
