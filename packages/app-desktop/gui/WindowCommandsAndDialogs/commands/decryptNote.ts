import { CommandRuntime, CommandDeclaration, CommandContext } from '@joplin/lib/services/CommandService';
import { _ } from '@joplin/lib/locale';
import Note from '@joplin/lib/models/Note';
import {
	permanentlyDecryptNote,
	isNoteEncrypted,
	getSessionPassword,
	setSessionPassword,
} from '@joplin/lib/services/encryption/PerNoteEncryptionService';
import shim from '@joplin/lib/shim';
import { WindowControl } from '../utils/useWindowControl';

export const declaration: CommandDeclaration = {
	name: 'decryptNote',
	label: () => _('Remove note encryption'),
};

export const runtime = (comp: WindowControl): CommandRuntime => {
	return {
		execute: async (context: CommandContext, noteIds: string[] = null) => {
			if (noteIds === null) noteIds = context.state.selectedNoteIds;
			if (!noteIds.length) return;

			let password = getSessionPassword();
			if (!password) {
				const entered = await comp.showPasswordInput(
					_('Enter password to remove encryption'),
					_('Enter the password used to encrypt this note.'),
				);
				if (!entered) return;
				password = entered;
			}

			for (const noteId of noteIds) {
				const note = await Note.load(noteId);
				if (!note || !isNoteEncrypted(note)) continue;
				try {
					const decrypted = await permanentlyDecryptNote(note, password);
					await Note.save({
						id: noteId,
						title: decrypted.title,
						body: decrypted.body,
						is_encrypted: 0,
						encrypted_metadata: '',
					}, { changeId: 'editorChange-decryptCmd' });
					setSessionPassword(password);
				} catch {
					const entered = await comp.showPasswordInput(
						_('Incorrect password'),
						_('Enter the correct password to remove encryption.'),
					);
					if (!entered) return;
					try {
						const decrypted = await permanentlyDecryptNote(note, entered);
						await Note.save({
							id: noteId,
							title: decrypted.title,
							body: decrypted.body,
							is_encrypted: 0,
							encrypted_metadata: '',
						}, { changeId: 'editorChange-decryptCmd' });
						setSessionPassword(entered);
					} catch (error) {
						void shim.showErrorDialog(_('Could not decrypt note: %s', (error as Error).message));
						return;
					}
				}
			}
		},
		enabledCondition: 'oneNoteSelected && !noteIsReadOnly',
	};
};
