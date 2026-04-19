import { setupDatabaseAndSynchronizer, switchClient } from '../../testing/test-utils';
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
		EncryptionService.instance_ = new EncryptionService();
		clearPasswordCache();
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

		clearPasswordCache();
		const decrypted = await decryptNote(encrypted, 'password');

		expect(decrypted.title).toBe(note.title);
		expect(decrypted.body).toBe(note.body);
		// is_encrypted remains 1 — the at-rest state is unchanged
		expect(decrypted.is_encrypted).toBe(1);
	});

	it('should throw on wrong password', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'correct');

		clearPasswordCache();
		await expect(decryptNote(encrypted, 'wrong')).rejects.toThrow();
	});

	it('should permanently decrypt a note and clear encryption flags', async () => {
		const note = makeNote();
		const encrypted = await encryptNote(note, 'pw');

		clearPasswordCache();
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

	it('clearPasswordCache resets the session password', () => {
		setSessionPassword('temporary');
		clearPasswordCache();
		expect(getSessionPassword()).toBeNull();
	});

	it('each note can use a different password independently', async () => {
		const noteA = makeNote({ id: 'aaa', body: 'body A' });
		const noteB = makeNote({ id: 'bbb', body: 'body B' });
		const encA = await encryptNote(noteA, 'pwA');
		const encB = await encryptNote(noteB, 'pwB');

		clearPasswordCache();
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

		clearPasswordCache();
		const decrypted = await decryptNote(legacyEncrypted, 'pw');

		expect(decrypted.title).toBe(note.title);
		expect(decrypted.body).toBe(note.body);
	});
});
