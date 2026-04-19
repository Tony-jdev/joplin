import { RefObject, useCallback } from 'react';
import { FormNote, NoteBodyEditorRef } from './types';
import { formNoteToNote } from '.';
import ExternalEditWatcher from '@joplin/lib/services/ExternalEditWatcher';
import Note from '@joplin/lib/models/Note';
import type { Dispatch } from 'redux';
import eventManager, { EventName } from '@joplin/lib/eventManager';
import type { OnSetFormNote } from './useFormNote';

interface Props {
	setFormNote: RefObject<OnSetFormNote>;
	editorId: string;
	dispatch: Dispatch;
	editorRef: RefObject<NoteBodyEditorRef>;
}

const useScheduleSaveCallbacks = (props: Props) => {
	const scheduleSaveNote = useCallback((formNote: FormNote) => {
		if (!formNote.saveActionQueue) throw new Error('saveActionQueue is not set!!'); // Sanity check

		// reg.logger().debug('Scheduling...', formNote);

		const makeAction = (formNote: FormNote) => {
			return async function() {
				// Reload the note's encryption state from the DB before saving.
				// A queued save action may have been created before the note was
				// encrypted/decrypted (e.g. the user queued an edit, then clicked
				// "Encrypt note"). Using the stale formNote.is_encrypted would save
				// plaintext to a note that is now marked is_encrypted=1 in the DB.
				const currentDb = await Note.load(formNote.id);
				if (!currentDb) {
					return;
				}
				const currentIsEncrypted = currentDb.is_encrypted || 0;
				const mergedFormNote: FormNote = {
					...formNote,
					is_encrypted: currentIsEncrypted,
					encrypted_metadata: currentDb.encrypted_metadata || '',
					// Use DB ciphertext as a fallback so the session-expiry path
					// never falls through to saving plaintext.
					lastSavedEncryptedBody: formNote.lastSavedEncryptedBody ?? (currentIsEncrypted ? currentDb.body : undefined),
				};

				const note = await formNoteToNote(mergedFormNote);
				const savedNote = await Note.save(note, { changeId: `editorChange-${props.editorId}` });

				props.setFormNote.current((prev: FormNote) => {
					// Only update if we are still editing the same note — prevents a
					// completed async save from mutating a different note's formNote.
					if (prev.id !== mergedFormNote.id) {
						return prev;
					}
					// After a successful re-encryption, track the new ciphertext as the fallback.
					const lastSavedEncryptedBody = prev.is_encrypted === 1 && note.body ? note.body : prev.lastSavedEncryptedBody;
					return { ...prev, user_updated_time: savedNote.user_updated_time, hasChanged: false, lastSavedEncryptedBody };
				});

				void ExternalEditWatcher.instance().updateNoteFile(savedNote);

				props.dispatch({
					type: 'EDITOR_NOTE_STATUS_REMOVE',
					id: formNote.id,
				});

				eventManager.emit(EventName.NoteContentChange, { note: savedNote });
			};
		};

		formNote.saveActionQueue.push(makeAction(formNote));
		return formNote.saveActionQueue.waitForAllDone();
	}, [props.dispatch, props.editorId, props.setFormNote]);

	const saveNoteIfWillChange = useCallback(async (formNote: FormNote) => {
		if (!formNote.id || !formNote.bodyWillChangeId || !props.editorRef.current) {
			return;
		}

		const body = await props.editorRef.current.content();

		void scheduleSaveNote({
			...formNote,
			body: body,
			bodyWillChangeId: 0,
			bodyChangeId: 0,
		});
	}, [scheduleSaveNote, props.editorRef]);

	return { saveNoteIfWillChange, scheduleSaveNote };
};

export default useScheduleSaveCallbacks;
