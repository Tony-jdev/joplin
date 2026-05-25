import { SqlQuery } from '../types';

export default (): (SqlQuery|string)[] => {
	return [
		'ALTER TABLE resources ADD COLUMN is_per_note_encrypted INT NOT NULL DEFAULT 0',
		'ALTER TABLE resources ADD COLUMN per_note_encrypted_metadata TEXT',
	];
};
