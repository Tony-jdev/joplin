import { FormNote } from './types';

import HtmlToMd, { ParseOptions } from '@joplin/lib/HtmlToMd';
import Note from '@joplin/lib/models/Note';
import { NoteEntity } from '@joplin/lib/services/database/types';
import { encryptNote, getSessionPassword } from '@joplin/lib/services/encryption/PerNoteEncryptionService';
const { MarkupToHtml } = require('@joplin/renderer');

export async function htmlToMarkdown(markupLanguage: number, html: string, originalCss: string, parseOptions: ParseOptions = null): Promise<string> {
	let newBody = '';

	if (markupLanguage === MarkupToHtml.MARKUP_LANGUAGE_MARKDOWN) {
		const htmlToMd = new HtmlToMd();
		newBody = htmlToMd.parse(html, {
			preserveImageTagsWithSize: true,
			preserveNestedTables: true,
			preserveTableStyles: true,
			preserveColorStyles: true,
			...parseOptions,
		});
		newBody = await Note.replaceResourceExternalToInternalLinks(newBody, { useAbsolutePaths: true });
	} else {
		newBody = await Note.replaceResourceExternalToInternalLinks(html, { useAbsolutePaths: true });
		if (originalCss) newBody = `<style>${originalCss}</style>\n${newBody}`;
	}

	return newBody;
}

export async function formNoteToNote(formNote: FormNote): Promise<NoteEntity> {
	let body = formNote.body;
	let is_encrypted: number | undefined = undefined;
	let encrypted_metadata: string | undefined = undefined;

	if (formNote.is_encrypted === 1) {
		const password = getSessionPassword();

		// Guard: if the body is identical to the last saved ciphertext it has already
		// been encrypted (e.g. after an initNoteState refresh that reset body to the DB
		// value). Re-encrypting it would produce double-encryption that cannot be
		// decrypted with the original password.
		const bodyIsAlreadyCiphertext =
			formNote.lastSavedEncryptedBody !== undefined &&
			formNote.body === formNote.lastSavedEncryptedBody;

		if (bodyIsAlreadyCiphertext) {
			body = formNote.body;
			is_encrypted = 1;
			encrypted_metadata = formNote.encrypted_metadata;
		} else if (password) {
			// Re-encrypt the current (possibly edited) plaintext body before writing to DB.
			// This keeps the note encrypted at rest while allowing in-memory editing.
			const reEncrypted = await encryptNote(
				{ id: formNote.id, title: formNote.title, body: formNote.body, is_encrypted: 1 },
				password,
			);
			body = reEncrypted.body;
			is_encrypted = 1;
			encrypted_metadata = reEncrypted.encrypted_metadata;
		} else if (formNote.lastSavedEncryptedBody) {
			// Session expired — fall back to the last known good ciphertext to avoid
			// writing plaintext to the DB. The user's recent edits in this session will
			// be lost, but the note stays encrypted and readable after the next unlock.
			body = formNote.lastSavedEncryptedBody;
			is_encrypted = 1;
			encrypted_metadata = formNote.encrypted_metadata;
		}
	}

	return {
		id: formNote.id,
		// Should also include parent_id and deleted_time so that the reducer
		// can know in which folder the note should go when saving.
		// https://discourse.joplinapp.org/t/experimental-wysiwyg-editor-in-joplin/6915/57?u=laurent
		parent_id: formNote.parent_id,
		deleted_time: formNote.deleted_time,
		is_conflict: formNote.is_conflict,
		title: formNote.title,
		body,
		...(is_encrypted !== undefined && { is_encrypted, encrypted_metadata }),
	};
}
