import { SqlQuery } from '../types';

export default (): (SqlQuery|string)[] => {
	return [
		'ALTER TABLE notes ADD COLUMN is_encrypted INT NOT NULL DEFAULT 0',
		'ALTER TABLE notes ADD COLUMN encrypted_metadata TEXT',
	];
};
