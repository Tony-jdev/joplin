# Google Summer of Code — Final Report

**Project Title:** Support for encrypted notes and notebooks  
**Organization:** Joplin  
**Primary mentor:** [@mrjo118](https://github.com/mrjo118)  
**Secondary mentors:** [@personalizedrefrigerator](https://github.com/personalizedrefrigerator), [@Daeraxa](https://github.com/Daeraxa)  
**Contributor(s):**  Artem Popko, Stanislav Hromak
**GitHub profile:** [@Tony-jdev](https://github.com/Tony-jdev) [@StanislavHromak](https://github.com/StanislavHromak)

**Development branch:** `features/Encryption`  
**Repository:** [laurent22/joplin](https://github.com/laurent22/joplin)  
**Project duration:** 

**Expected project size:** 175 hours  

---

## Project overview

Joplin notes are normally readable as soon as they are opened. This project adds **optional per-note encryption**: the user can protect sensitive notes (and their attachments) with a **note-specific password**. The note title stays visible in the note list; the body and linked resources are encrypted at rest until the correct password is entered.

Implementation lives on the `features/Encryption` branch. Scope for this delivery: **Joplin Desktop** (`packages/lib`, `packages/app-desktop`). Mobile clients are out of scope for this iteration.

---

## Goals of the project (from proposal)


| Goal                                                                  | Status                                      |
| --------------------------------------------------------------------- | ------------------------------------------- |
| User can encrypt selected notes with a password                       | ✅ Completed                                 |
| Encrypted note can only be read with that password                    | ✅ Completed                                 |
| Associated resources (images, files) encrypted with the same password | ✅ Completed                                 |
| Desktop UI: encrypt, unlock, decrypt/remove encryption                | ✅ Completed                                 |
| Coexistence with existing Joplin E2EE (master key)                    | ✅ Verified in tests                         |
| Encrypt entire notebooks in one action                                | ⏳ Not in current scope (future enhancement) |


---

## Expected outcome vs delivered

**Expected outcome (proposal):**  
The user can choose to encrypt certain notes and associated resources, enter a password, and decrypt only with that password.

**Delivered:**

1. **Database schema** — migrations for `notes` and `resources` per-note flags and metadata.
2. `PerNoteEncryptionService` — encrypt/decrypt API for note bodies and attachment blobs, session password cache, legacy format support.
3. **Desktop commands** — *Encrypt note* and *Remove encryption* from the note context menu.
4. **Lock screen** — when opening an encrypted note, user enters password (with optional auto-unlock using session cache).
5. **Editor integration** — decrypted content in memory while editing; re-encryption on save when the note remains encrypted.
6. **Note list** — visual indicator (lock) for encrypted notes.
7. **Automated tests** — 19 unit tests for `PerNoteEncryptionService` (all passing).
8. **Translations** — Ukrainian strings added in `uk_UA.json`.

---

## Work completed

### Commits on `features/Encryption`


| Commit      | Summary                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `d689d57fe` | Core: migration 50, `PerNoteEncryptionService`, encrypt command, password dialog |
| `8bc352a9a` | Decryption UI: lock screen, decrypt command, editor hooks, note list             |
| `d2ba7584e` | Resource encryption: migration 51, attachment blobs, extended service & tests    |


**Branch diff (vs base):** 28 files changed, ~1 489 insertions, ~112 deletions.

---

## Features implemented

### 1. Per-note encryption for note body

- Only `body` is encrypted; `title` stays plaintext so notes remain identifiable in the list.  
- Flags: `notes.is_encrypted`, `notes.encrypted_metadata` (JSON: version + encryption method).  
- Ciphertext stored as **StringV1** JSON (`salt`, `iv`, `ct`) via existing `EncryptionService`.

**Key files:**

- `packages/lib/services/encryption/PerNoteEncryptionService.ts` — `encryptNote`, `decryptNote`, `permanentlyDecryptNote`  
- `packages/lib/services/database/migrations/50.ts`  
- `packages/app-desktop/gui/WindowCommandsAndDialogs/commands/encryptNote.ts`

### 2. Per-note encryption for linked resources

- Attachments referenced in the note body (`:/{resourceId}`) can be encrypted with the **same note password**.  
- Blob stored on disk as `{resourceId}.pnenc`; metadata in `resources.is_per_note_encrypted`, `resources.per_note_encrypted_metadata`.  
- If a resource is shared by multiple notes, it is **duplicated** so each encrypted note owns its copy (`ensureExclusiveResourcesForNote`).  
- Max blob size: **15 MB** per attachment for StringV1 whole-file encryption.

**Key files:**

- `packages/lib/services/database/migrations/51.ts`  
- `packages/lib/models/Resource.ts` — `perNoteEncryptedPath()`  
- `packages/lib/models/utils/resourceUtils.ts` — `.pnenc` extension

### 3. Session password cache

- Password kept in memory for **15 minutes** (renderer `window` global — avoids duplicate module instances under esbuild).  
- Enables auto-unlock when reopening a note encrypted with the same password in the same session.  
- `clearPasswordCache` re-locks attachment files on disk when the session ends.

---

**Design principles:**

- Service layer returns updated entities; **callers** persist via `Note.save` / `Resource.save`.  
- **In-memory decrypt** (`decryptNote`) leaves `is_encrypted = 1` in the database.  
- **Permanent decrypt** (`permanentlyDecryptNote`) clears flags and restores plaintext at rest.  
- Editor saves use `changeId: 'editorChange-…'` to avoid spurious reloads from sync hooks.

---

## Learning experience

- TypeScript/React patterns in the Joplin codebase  
- Reuse of `EncryptionService` and migration workflow in `packages/lib`  
- Designing UX for lock/unlock without blocking the rest of the app  
- Writing tests with `setupDatabaseAndSynchronizer` and attachment fixtures

---

## Summary of contribution

On branch `features/Encryption`, we implemented **optional per-note encryption** for Joplin Desktop: password-protected note bodies and linked attachments, with a clear separation from profile-wide E2EE. The work includes database migrations, a dedicated encryption service (~400 lines) and lock-screen UI, editor lifecycle hooks, note-list indicators, and a focused unit-test suite (19 tests).

Users can encrypt sensitive notes from the context menu, unlock them in the editor with a password, and remove encryption when no longer needed. Attachments are handled safely, including the case where the same file was linked from multiple notes. The implementation builds on Joplin’s existing **AES-256-GCM / StringV1** stack for consistency and maintainability.

---

