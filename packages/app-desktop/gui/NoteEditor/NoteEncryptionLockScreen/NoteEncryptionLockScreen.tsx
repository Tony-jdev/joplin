import * as React from 'react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { _ } from '@joplin/lib/locale';
import { decryptNote, getSessionPassword, setSessionPassword } from '@joplin/lib/services/encryption/PerNoteEncryptionService';
import { NoteEntity } from '@joplin/lib/services/database/types';
import { focus } from '@joplin/lib/utils/focusHandler';

interface Props {
	note: NoteEntity;
	onUnlock: (decrypted: { title: string; body: string })=> void;
}

export default function NoteEncryptionLockScreen(props: Props) {
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const [unlocking, setUnlocking] = useState(false);
	const [autoUnlockFailed, setAutoUnlockFailed] = useState(false);
	const passwordInputRef = useRef<HTMLInputElement>(null);
	const onUnlockRef = useRef(props.onUnlock);
	onUnlockRef.current = props.onUnlock;

	const noteEntity = useMemo((): NoteEntity => ({
		id: props.note.id,
		title: props.note.title,
		body: props.note.body,
		is_encrypted: props.note.is_encrypted,
		encrypted_metadata: props.note.encrypted_metadata || '',
	}), [props.note.id, props.note.title, props.note.body, props.note.is_encrypted, props.note.encrypted_metadata]);

	// Attempt silent auto-unlock using the last password entered this session.
	// If the note was encrypted with a different password the attempt fails silently
	// and the manual input form is revealed.
	useEffect(() => {
		const sessionPassword = getSessionPassword();
		if (!sessionPassword) {
			setAutoUnlockFailed(true);
			return undefined;
		}
		setUnlocking(true);
		let cancelled = false;
		void (async () => {
			try {
				const decrypted = await decryptNote(noteEntity, sessionPassword);
				if (cancelled) return;
				onUnlockRef.current({ title: decrypted.title || '', body: decrypted.body || '' });
			} catch {
				if (cancelled) return;
				setUnlocking(false);
				setAutoUnlockFailed(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [noteEntity]);

	const onPasswordChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setPassword(event.target.value);
		setError('');
	}, []);

	const onUnlock = useCallback(async () => {
		if (!password) return;
		setUnlocking(true);
		setError('');
		try {
			const decrypted = await decryptNote(noteEntity, password);
			setSessionPassword(password);
			props.onUnlock({ title: decrypted.title || '', body: decrypted.body || '' });
		} catch {
			setError(_('Incorrect password or corrupted note. Please try again.'));
			setPassword('');
			if (passwordInputRef.current) focus('NoteEncryptionLockScreen::onUnlock', passwordInputRef.current);
		} finally {
			setUnlocking(false);
		}
	}, [password, noteEntity, props.onUnlock]);

	const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') void onUnlock();
	}, [onUnlock]);

	if (unlocking && !autoUnlockFailed) {
		return (
			<div style={styles.container}>
				<div style={styles.card}>
					<div style={styles.lockIcon}>🔒</div>
					<p style={styles.description}>{_('Unlocking…')}</p>
				</div>
			</div>
		);
	}

	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<div style={styles.lockIcon}>🔒</div>
				<h2 style={styles.title}>{_('Note is encrypted')}</h2>
				<p style={styles.description}>
					{_('This note is protected with a password. Enter the password used when encrypting it.')}
				</p>
				<input
					ref={passwordInputRef}
					style={styles.input}
					type="password"
					placeholder={_('Note password')}
					value={password}
					onChange={onPasswordChange}
					onKeyDown={onKeyDown}
					disabled={unlocking}
					autoFocus
				/>
				{error ? <p style={styles.error}>{error}</p> : null}
				<button
					style={password ? styles.button : styles.buttonDisabled}
					onClick={onUnlock}
					disabled={!password || unlocking}
				>
					{unlocking ? _('Unlocking…') : _('Unlock')}
				</button>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		padding: 20,
		boxSizing: 'border-box',
	},
	card: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		padding: '32px 40px',
		borderRadius: 8,
		maxWidth: 360,
		width: '100%',
		border: '1px solid #ccc',
		gap: 12,
	},
	lockIcon: {
		fontSize: 40,
		lineHeight: '1',
	},
	title: {
		margin: 0,
		fontSize: 18,
		fontWeight: 600,
	},
	description: {
		margin: 0,
		textAlign: 'center',
		fontSize: 14,
		opacity: 0.8,
	},
	input: {
		width: '100%',
		padding: '8px 12px',
		fontSize: 14,
		borderRadius: 4,
		border: '1px solid #aaa',
		boxSizing: 'border-box',
	},
	error: {
		margin: 0,
		color: '#c0392b',
		fontSize: 13,
		textAlign: 'center',
	},
	button: {
		padding: '8px 24px',
		fontSize: 14,
		borderRadius: 4,
		border: 'none',
		cursor: 'pointer',
		background: '#1a73e8',
		color: '#fff',
	},
	buttonDisabled: {
		padding: '8px 24px',
		fontSize: 14,
		borderRadius: 4,
		border: 'none',
		cursor: 'not-allowed',
		background: '#aaa',
		color: '#fff',
	},
};
