import { CommandRuntime, CommandDeclaration, CommandContext } from '@joplin/lib/services/CommandService';
import { _ } from '@joplin/lib/locale';
import Note from '@joplin/lib/models/Note';
import {
	encryptNote,
	isNoteEncrypted,
	setSessionPassword,
} from '@joplin/lib/services/encryption/PerNoteEncryptionService';
import shim from '@joplin/lib/shim';
import { WindowControl } from '../utils/useWindowControl';

export const declaration: CommandDeclaration = {
	name: 'encryptNote',
	label: () => _('Encrypt note'),
};

export const runtime = (comp: WindowControl): CommandRuntime => {
	return {
		execute: async (context: CommandContext, noteIds: string[] = null) => {
			if (noteIds === null) noteIds = context.state.selectedNoteIds;
			if (!noteIds.length) return;

			const password = await comp.showPasswordInput(
				_('Please enter a password to encrypt this note'),
			);
			if (!password) return;

			for (const noteId of noteIds) {
				const note = await Note.load(noteId);
				if (!note || isNoteEncrypted(note)) continue;
				try {
					const encrypted = await encryptNote(note, password);
					// changeId prefix 'editorChange-' prevents useRefreshFormNoteOnChange
					// from treating this save as an external change and triggering a reload
					// that would overwrite the editor's in-memory decrypted state.
					await Note.save({
						id: noteId,
						body: encrypted.body,
						is_encrypted: encrypted.is_encrypted,
						encrypted_metadata: encrypted.encrypted_metadata,
					}, { changeId: 'editorChange-encryptCmd' });
				} catch (error) {
					void shim.showErrorDialog(_('Could not encrypt note "%s": %s', note.title, (error as Error).message));
					return;
				}
			}

			setSessionPassword(password);
		},
		enabledCondition: 'oneNoteSelected && !noteIsReadOnly',
	};
};
