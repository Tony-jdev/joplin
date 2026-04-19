import EncryptionService, { EncryptionMethod } from '../e2ee/EncryptionService';
import { NoteEntity } from '../database/types';

// Metadata stored unencrypted alongside an encrypted note body so any
// future client can detect how to decrypt it.
export interface PerNoteEncryptionMetadata {
	version: number;
	method: EncryptionMethod;
}

const METADATA_VERSION = 1;

// Store the session password directly on `window` so ALL code in the renderer
// process shares the same value regardless of how esbuild resolved this module.
// This prevents issues when esbuild creates multiple module instances of this
// file (once for .ts imports, once for .js imports) each with their own
// module-level variable.
const WINDOW_KEY = '__joplinPerNoteEncPwd';
const WINDOW_EXP_KEY = '__joplinPerNoteEncExp';
const CACHE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global_ = (typeof window !== 'undefined' ? window : global) as any;

const touchCache_ = (password: string) => {
	global_[WINDOW_KEY] = password;
	if (global_[WINDOW_EXP_KEY]) clearTimeout(global_[WINDOW_EXP_KEY]);
	global_[WINDOW_EXP_KEY] = setTimeout(() => {
		global_[WINDOW_KEY] = null;
		global_[WINDOW_EXP_KEY] = null;
	}, CACHE_TIMEOUT_MS);
};

// Clears the in-memory session cache (e.g. on app lock or user request).
export const clearPasswordCache = () => {
	global_[WINDOW_KEY] = null;
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

export const isNoteEncrypted = (note: NoteEntity): boolean => {
	return !!note.is_encrypted;
};

export const getNoteEncryptionInfo = (note: NoteEntity): PerNoteEncryptionMetadata | null => {
	if (!isNoteEncrypted(note) || !note.encrypted_metadata) return null;
	try {
		return JSON.parse(note.encrypted_metadata) as PerNoteEncryptionMetadata;
	} catch {
		return null;
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

	// Backward compatibility: old notes encrypted the body as JSON({title, body}).
	// New notes encrypt just the body string.
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
// is_encrypted becomes 0 and encrypted_metadata is cleared.
export const permanentlyDecryptNote = async (note: NoteEntity, password: string): Promise<NoteEntity> => {
	const decrypted = await decryptNote(note, password);
	return {
		...decrypted,
		is_encrypted: 0,
		encrypted_metadata: '',
	};
};
