import Folder from '../../models/Folder';
import Note from '../../models/Note';
import NoteResource from '../../models/NoteResource';
import Resource from '../../models/Resource';
import shim from '../../shim';
import { setupAndEnableEncryption } from '../e2ee/utils';
import { encryptionService, loadEncryptionMasterKey, setupDatabaseAndSynchronizer, supportDir, switchClient } from '../../testing/test-utils';
import EncryptionService from '../e2ee/EncryptionService';
import {
	encryptNote,
	decryptNote,
	permanentlyDecryptNote,
	isNoteEncrypted,
	getNoteEncryptionInfo,
	clearPasswordCache,
	getSessionPassword,
	setSessionPassword,
	getLastUnlockedNoteId,
	setLastUnlockedNoteId,
	ensureExclusiveResourcesForNote,
	encryptLinkedResourcesForNote,
	decryptResourceBlobToPlaintext,
	ensureResourcesDecryptedForNote,
	reencryptAllSessionResources,
	isResourcePerNoteEncrypted,
} from './PerNoteEncryptionService';
import { NoteEntity } from '../database/types';

const makeNote = (overrides: Partial<NoteEntity> = {}): NoteEntity => ({
	id: 'abc123def456abc123def456abc12345',
	title: 'Test note title',
	body: 'Test note body with some content',
	is_encrypted: 0,
	encrypted_metadata: '',
	...overrides,
});

describe('PerNoteEncryptionService', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		EncryptionService.instance_ = encryptionService();
		await clearPasswordCache();
	});

	afterEach(async () => {
		await clearPasswordCache();
	});

	it('should detect unencrypted notes correctly', () => {
		const note = makeNote();
		expect(isNoteEncrypted(note)).toBe(false);
		expect(getNoteEncryptionInfo(note)).toBeNull();
	});

	it('should encrypt only the body, leaving the title visible', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'secret');

		expect(encrypted.is_encrypted).toBe(1);
		// Title must remain unchanged so the note list can identify the note.
		expect(encrypted.title).toBe(note.title);
		expect(encrypted.body).not.toBe(note.body);
		expect(encrypted.encrypted_metadata).toBeTruthy();
		expect(isNoteEncrypted(encrypted)).toBe(true);
		expect(getNoteEncryptionInfo(encrypted)).not.toBeNull();
	});

	it('should decrypt an encrypted note with the correct password', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'password');

		await clearPasswordCache();
		const decrypted = await decryptNote(encrypted, 'password');

		expect(decrypted.title).toBe(note.title);
		expect(decrypted.body).toBe(note.body);
		// is_encrypted remains 1 — the at-rest state is unchanged
		expect(decrypted.is_encrypted).toBe(1);
	});

	it('should throw on wrong password', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'correct');

		await clearPasswordCache();
		await expect(decryptNote(encrypted, 'wrong')).rejects.toThrow();
	});

	it('should permanently decrypt a note and clear encryption flags', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'pw');

		await clearPasswordCache();
		const plain = await permanentlyDecryptNote(encrypted, 'pw');

		expect(plain.is_encrypted).toBe(0);
		expect(plain.encrypted_metadata).toBe('');
		expect(plain.title).toBe(note.title);
		expect(plain.body).toBe(note.body);
	});

	it('should pass through unencrypted notes in decryptNote unchanged', async () => {
		const note = makeNote();
		const result = await decryptNote(note, 'anything');
		expect(result.title).toBe(note.title);
		expect(result.body).toBe(note.body);
	});

	it('getSessionPassword returns null before any password is used this session', () => {
		expect(getSessionPassword()).toBeNull();
	});

	it('setSessionPassword caches the password and getSessionPassword returns it', () => {
		setSessionPassword('per-note-pw');
		expect(getSessionPassword()).toBe('per-note-pw');
	});

	it('clearPasswordCache resets the session password', async () => {
		setSessionPassword('temporary');
		await clearPasswordCache();
		expect(getSessionPassword()).toBeNull();
	});

	it('clearPasswordCache resets the last unlocked note ID', async () => {
		setSessionPassword('temporary');
		setLastUnlockedNoteId('note-id');

		expect(getLastUnlockedNoteId()).toBe('note-id');

		await clearPasswordCache();

		expect(getSessionPassword()).toBeNull();
		expect(getLastUnlockedNoteId()).toBeNull();
	});

	it('each note can use a different password independently', async () => {
		const noteA = makeNote({ id: 'aaa', body: 'body A' });
		const noteB = makeNote({ id: 'bbb', body: 'body B' });
		const encA = await encryptNote(noteA, 'pwA');
		const encB = await encryptNote(noteB, 'pwB');

		await clearPasswordCache();
		await expect(decryptNote(encA, 'pwB')).rejects.toThrow();
		await expect(decryptNote(encB, 'pwA')).rejects.toThrow();
		const da = await decryptNote(encA, 'pwA');
		const db = await decryptNote(encB, 'pwB');
		expect(da.body).toBe('body A');
		expect(db.body).toBe('body B');
	});

	it('should decrypt legacy notes where body was JSON-encoded {title, body}', async () => {
		// Simulate a note encrypted with the old implementation that wrapped title+body in JSON.
		const note = makeNote();
		const legacyPayload = JSON.stringify({ title: note.title, body: note.body });

		const { EncryptionMethod } = await import('../e2ee/EncryptionService');
		const cipherText = await EncryptionService.instance().encrypt(EncryptionMethod.StringV1, 'pw', legacyPayload);
		const legacyEncrypted: NoteEntity = {
			...note,
			title: '',
			body: cipherText,
			is_encrypted: 1,
			encrypted_metadata: JSON.stringify({ version: 1, method: EncryptionMethod.StringV1 }),
		};

		await clearPasswordCache();
		const decrypted = await decryptNote(legacyEncrypted, 'pw');

		expect(decrypted.title).toBe(note.title);
		expect(decrypted.body).toBe(note.body);
	});

	it('should keep per-note encrypted content readable after Joplin E2EE serialization', async () => {
		const masterKey = await loadEncryptionMasterKey();
		await setupAndEnableEncryption(EncryptionService.instance(), masterKey, '123456');

		const folder = await Folder.save({ title: 'E2EE folder' });
		const note = await Note.save({
			title: 'Per-note encrypted note',
			body: 'Body protected by the note password',
			parent_id: folder.id,
		});

		const perNoteEncrypted = await encryptNote(note, 'note-password');
		const savedPerNoteEncrypted = await Note.save(perNoteEncrypted);

		const serialized = await Note.serializeForSync(savedPerNoteEncrypted);
		const encryptedForSync = Note.filter(await Note.unserialize(serialized));

		expect(encryptedForSync.encryption_applied).toBe(1);
		expect(encryptedForSync.encryption_cipher_text).toBeTruthy();
		expect(encryptedForSync.body || '').toBe('');

		const savedE2eeEncrypted = await Note.save(encryptedForSync);
		const afterE2eeDecrypt = await Note.decrypt(savedE2eeEncrypted);

		expect(afterE2eeDecrypt.title).toBe(note.title);
		expect(afterE2eeDecrypt.is_encrypted).toBe(1);
		expect(afterE2eeDecrypt.encrypted_metadata).toBe(savedPerNoteEncrypted.encrypted_metadata);
		expect(afterE2eeDecrypt.body).toBe(savedPerNoteEncrypted.body);
		expect(afterE2eeDecrypt.body).not.toBe(note.body);

		const fullyDecrypted = await decryptNote(afterE2eeDecrypt, 'note-password');

		expect(fullyDecrypted.title).toBe(note.title);
		expect(fullyDecrypted.body).toBe(note.body);
	});

	it('should encrypt linked attachment blobs when encrypting a note', async () => {
		const folder = await Folder.save({ title: 'Encrypt resources folder' });
		let note = await Note.save({ title: 'With photo', body: 'Hello', parent_id: folder.id });
		note = await shim.attachFileToNote(note, `${supportDir}/photo.jpg`);

		const { body, resourceIds } = await ensureExclusiveResourcesForNote(note);
		expect(resourceIds.length).toBe(1);

		await encryptLinkedResourcesForNote({ ...note, body }, 'note-pw', resourceIds);
		const encrypted = await encryptNote({ ...note, body }, 'note-pw');
		await Note.save({ ...encrypted, id: note.id });

		const resource = await Resource.load(resourceIds[0]);
		expect(isResourcePerNoteEncrypted(resource)).toBe(true);
		expect(await Resource.fsDriver().exists(Resource.perNoteEncryptedPath(resource))).toBe(true);
		expect(await Resource.fsDriver().exists(Resource.fullPath(resource))).toBe(false);
	});

	it('should throw on wrong password when decrypting an attachment', async () => {
		const folder = await Folder.save({ title: 'Wrong pw folder' });
		let note = await Note.save({ title: 'Photo', body: 'x', parent_id: folder.id });
		note = await shim.attachFileToNote(note, `${supportDir}/photo.jpg`);
		const { body, resourceIds } = await ensureExclusiveResourcesForNote(note);
		await encryptLinkedResourcesForNote({ ...note, body }, 'right', resourceIds);
		const resource = await Resource.load(resourceIds[0]);

		await expect(decryptResourceBlobToPlaintext(resource, 'wrong')).rejects.toThrow();
	});

	it('should duplicate a shared resource when encrypting one note', async () => {
		const folder = await Folder.save({ title: 'Shared res folder' });
		let note1 = await Note.save({ title: 'Note 1', body: 'A', parent_id: folder.id });
		note1 = await shim.attachFileToNote(note1, `${supportDir}/photo.jpg`);
		const resourceId = (await Note.linkedResourceIds(note1.body))[0];

		const note2 = await Note.save({
			title: 'Note 2',
			body: note1.body,
			parent_id: folder.id,
		});
		await NoteResource.setAssociatedResources(note1.id, [resourceId]);
		await NoteResource.setAssociatedResources(note2.id, [resourceId]);

		const { body, resourceIds } = await ensureExclusiveResourcesForNote(note1);
		expect(resourceIds.length).toBe(1);
		expect(resourceIds[0]).not.toBe(resourceId);
		expect(body.includes(resourceIds[0])).toBe(true);
		expect(body.includes(resourceId)).toBe(false);
	});

	it('should restore plaintext attachment paths on unlock and re-encrypt on clearPasswordCache', async () => {
		const folder = await Folder.save({ title: 'Session folder' });
		let note = await Note.save({ title: 'Session', body: 'Y', parent_id: folder.id });
		note = await shim.attachFileToNote(note, `${supportDir}/photo.jpg`);
		const { body, resourceIds } = await ensureExclusiveResourcesForNote(note);
		await encryptLinkedResourcesForNote({ ...note, body }, 'sess-pw', resourceIds);
		const encrypted = await encryptNote({ ...note, body }, 'sess-pw');
		await Note.save({ ...encrypted, id: note.id });

		const decrypted = await decryptNote(encrypted, 'sess-pw');
		await ensureResourcesDecryptedForNote(note.id, 'sess-pw', decrypted.body || '');

		const resource = await Resource.load(resourceIds[0]);
		expect(await Resource.fsDriver().exists(Resource.fullPath(resource))).toBe(true);

		await reencryptAllSessionResources('sess-pw');
		expect(await Resource.fsDriver().exists(Resource.fullPath(resource))).toBe(false);
		expect(await Resource.fsDriver().exists(Resource.perNoteEncryptedPath(resource))).toBe(true);
	});

	it('should throw when per-note encrypting an attachment that still requires E2EE', async () => {
		const folder = await Folder.save({ title: 'E2EE resource folder' });
		let note = await Note.save({ title: 'E2EE res', body: 'Q', parent_id: folder.id });
		note = await shim.attachFileToNote(note, `${supportDir}/photo.jpg`);
		const resourceId = (await Note.linkedResourceIds(note.body))[0];

		await Resource.save({
			id: resourceId,
			encryption_applied: 1,
		});

		await expect(encryptLinkedResourcesForNote(note, 'pw', [resourceId])).rejects.toThrow(/end-to-end encryption/i);
	});

	it('should permanently decrypt linked attachments when removing note encryption', async () => {
		const folder = await Folder.save({ title: 'Permanent decrypt folder' });
		let note = await Note.save({ title: 'Decrypt all', body: 'Z', parent_id: folder.id });
		note = await shim.attachFileToNote(note, `${supportDir}/photo.jpg`);
		const { body, resourceIds } = await ensureExclusiveResourcesForNote(note);
		await encryptLinkedResourcesForNote({ ...note, body }, 'perm', resourceIds);
		const encrypted = await encryptNote({ ...note, body }, 'perm');
		await Note.save({ ...encrypted, id: note.id });

		const plain = await permanentlyDecryptNote(encrypted, 'perm');
		await Note.save({ ...plain, id: note.id });

		const resource = await Resource.load(resourceIds[0]);
		expect(isResourcePerNoteEncrypted(resource)).toBe(false);
		expect(await Resource.fsDriver().exists(Resource.perNoteEncryptedPath(resource))).toBe(false);
		expect(await Resource.fsDriver().exists(Resource.fullPath(resource))).toBe(true);
	});
});
