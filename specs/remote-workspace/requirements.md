# Remote Workspace

1. When a monitor is created, it must reference one registered machine and a destination hostname/IP. Only that machine's authenticated agent may return its samples. Offline/old agents must produce explicit errors, never controller measurements.
2. When using WebSSH, an administrator can save, edit, delete and insert/run machine-scoped command shortcuts.
3. When browsing a machine, the administrator can navigate SFTP directories, discover common product directories, upload/download files and edit UTF-8 configuration/source files with syntax highlighting. Writes check revisions, preserve permissions and create backups.
4. When AI is configured, an administrator can choose a custom compatible endpoint, model and reasoning level, ask for changes in a chosen remote workspace, review file diffs and command proposals, and explicitly apply/execute them. Credentials remain encrypted on the controller.
5. Authentication, SSH host verification, resource limits, remote file validation and AI endpoint handling must be checked with negative tests.
6. After validation, commit and push changes to the existing GitHub repository. Publish an updated agent artifact because the protocol changes.
