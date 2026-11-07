# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository: open the **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a suspected vulnerability.

Include the affected package and version, the smallest reproduction you can share, and the impact you expect. Do not include real credentials, memory databases, session transcripts, or Telegram downloads.

## Supported versions

Security fixes target the latest published release of each package, or the current repository version for a package that is not yet published. Older versions may not receive a fix.

## Scope

These extensions run inside Pi with the permissions of the user running Pi. They are not sandboxes, and an extension or a model tool can read, write, or execute anything that user can.

Relevant reports include credential exposure, path or workspace containment bypasses, cross-chat or cross-session message delivery, unsafe file or URL handling, command or argument injection, and denial of service caused by untrusted input.

Provider outages, model output quality, and prompt-injection content produced by third-party services are not security vulnerabilities in these packages unless they cross one of the boundaries above.
