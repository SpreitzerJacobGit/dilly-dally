---
id: output/ntfy-push
package: "@elements/output-ntfy-push"
plane: data
category: output
version: 0.1.0
variationGroup: output/push-notify
variationAxis: "Which push channel carries the message — ntfy vs. a future web-push or email sibling. Propagates to device setup (ntfy app + topic subscription) and credential shape."
summary: Publishes push notifications to an ntfy topic with an append-only delivery log and at-most-once semantics per dedupe key, surviving restarts; failures are recorded and visible, never silently dropped.
provides: [notificationLog, NTFY_SETTINGS_KEY, NtfySettingsSchema, createNtfyPublisher, recentNotifications, saveNtfySettings, NtfySettings, NtfyMessage, NtfyPublisher, NtfyStatus, PublishResult, createNtfyStatusRouter]
requiresElements: [storage/sqlite-drizzle, lifecycle/app-settings, lifecycle/service-runtime, identity/session-auth, observability/structured-logging]
requiresConfig: []
claims:
  - "A message published with a dedupe key is delivered at most once, even across restarts; a failed attempt does not burn the key, so retries remain possible."
  - "Every delivery attempt is recorded with its outcome; a failed delivery is visible from the running application with its error — the application never claims a notification was sent that was not."
whenToUse: "Any vertical that pushes alerts or digests to phones without building web-push infrastructure — the ntfy app subscribes to a topic and the server publishes to it."
whenNotToUse: "Native PWA web-push (needs HTTPS + VAPID plumbing — a sibling variation), or transactional email."
---

## Purpose

The delivery half of proactive notification: a thin publisher over ntfy's HTTP API plus the bookkeeping that makes it honest — an append-only delivery log, at-most-once publishing per dedupe key, and a status surface. What to say and when to say it belongs to the vertical; carrying the message and accounting for it belongs here.

## Behavior

A publish attempt either reaches the ntfy server and is logged as sent, or fails and is logged as failed with the error. `publishOnce(key, msg)` never sends a key twice — a restart cannot re-deliver yesterday's digest — while a failed attempt leaves the key open so the next scheduled run retries. When no ntfy settings are stored the publisher reports "unconfigured" and does nothing else. The status router shows configuration state (the token's presence, never its value) and the recent delivery log.

## Configuration

None from the environment. Server URL, topic, and optional access token are stored lifecycle configuration (lifecycle/app-settings) entered by an operator through the application; the topic name is effectively the credential when using ntfy.sh, so verticals should seed or suggest an unguessable one.

## Wiring

The composition root or a bespoke job constructs the publisher with the db handle and logger. Recurring senders (a morning digest job) call `publishOnce` with a date-derived key; event-driven senders call `publish`. The status router mounts under the application router; a settings/status page invokes it.

## Variations & alternatives

`output/web-push` (future) would deliver through the installed PWA itself at the cost of HTTPS/VAPID infrastructure; `output/email-digest` (future) for inboxes. Same group, different channel axis.

## Limits

Delivery is fire-and-forget HTTP — no read receipts; "sent" means ntfy accepted the message, not that a phone displayed it. One topic per vertical. Attachments and action buttons are not surfaced. The log is append-only and unbounded (rows are tiny; pruning is a future concern).
