import { CommandRuntime, CommandDeclaration, CommandContext } from '@joplin/lib/services/CommandService';
import { _ } from '@joplin/lib/locale';
import Note from '@joplin/lib/models/Note';
import {
	permanentlyDecryptNote,
	isNoteEncrypted,
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

			for (const noteId of noteIds) {
				const note = await Note.load(noteId);
				if (!note || !isNoteEncrypted(note)) continue;

				const password = await comp.showPasswordInput(
					_('Enter password to remove encryption'),
					_('Enter the password used to encrypt this note.'),
					undefined,
					false,
				);

				if (!password) return;

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

				} catch (error) {
					void shim.showErrorDialog(_('Could not decrypt note: %s. Please check if the password is correct.', (error as Error).message));
					return;
				}
			}
		},
		enabledCondition: 'oneNoteSelected && !noteIsReadOnly',
	};
};
