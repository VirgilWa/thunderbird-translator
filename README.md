# Thunderbird Translator

**Email translation with explicit provider selection and failure-safe message updates**

This is a focused fork of [jctots/thunderbird-translator](https://github.com/jctots/thunderbird-translator), itself forked from [zoott28354/thunderbird-translator](https://github.com/zoott28354/thunderbird-translator).

## Features

- **Explicit provider selection** — fresh installs never send message text until a provider is chosen
- **Tencent TokenHub translation** — Hy-MT2-Lite by default, with Plus and Pro choices
- **Tencent usage visibility** — records API-reported input and output tokens used by this Thunderbird installation each month
- **Batched message translation** — sends ordinary message segments in one or a few bounded model requests
- **Local performance visibility** — records only duration, request, retry, and deduplication counts for the last translation
- Translate received email inline and restore it with one click
- Stage body and subject translations, then commit them together only after full success
- Cancel a long reading translation by clicking the action again
- Show progress and exact failures in the action tooltip and message view
- Translate selected text while composing
- Optional automatic translation
- Chinese and English user interfaces
- Conservative English/Chinese Tencent target menu
- Target-language preferences for reading and composing

## Requirements

- Thunderbird 128 or later
- Tencent TokenHub API Key when Tencent is selected

## Installation

1. Open Thunderbird Add-ons Manager.
2. Choose **Install Add-on From File** from the gear menu.
3. Select the generated `.xpi` file and confirm.

For temporary development loading, open **Debug Add-ons**, choose **Load Temporary Add-on**, and select `manifest.json`.

## Configuration

Fresh installs have no provider selected. Opening the translation action takes the user to add-on settings instead of sending message content implicitly.

Version 1.9.0 exposes Tencent TokenHub only. The retired no-key Microsoft adapter and the legacy Tencent TMT `TextTranslate` adapter have been removed.

Tencent requires a TokenHub-specific API Key. Legacy TMT `SecretId`/`SecretKey` credentials cannot be reused directly. The default `hy-mt2-lite` model prioritizes latency; `hy-mt2-plus` and `hy-mt2-pro` can be selected for higher-quality work. Tencent is never selected automatically and is never used as a fallback.

The menu is intentionally limited to English and Simplified Chinese, the directions used by this fork's email workflow.

Tencent removed `TextTranslate` from its current API catalog on 8 July 2026 and directs text-translation users to TokenHub Hy-MT2 models. This release uses the OpenAI-compatible TokenHub Chat Completions endpoint.

### Provider selection

The reproducible corpus in [`benchmarks/translation-quality-cases.json`](benchmarks/translation-quality-cases.json) covers academic notices, antenna engineering, peer review, scheduling, formatting, extension requests, technical argumentation, and procurement instructions.

The historical 2026-07-31 blind run found:

- Microsoft won 5 of 8 cases and all 3 Chinese-to-English cases.
- Tencent was marginally stronger for English-to-Chinese overall and preserved numbers and symbols better, but was less fluent.
- Microsoft was the stronger general result, but its former no-key endpoint is no longer usable by this extension.
- Tencent remains useful for English-to-Chinese technical reading when symbol fidelity is especially important.
- Manually review either provider for publication-critical technical text.

## Use

### Reading email

- Click the toolbar button to translate or restore the current message.
- Use the button's context menu to choose the target language or enable automatic translation.

### Composing email

1. Select text in the compose window.
2. Choose a target language from the compose action menu.
3. Click the translate button to replace the selection.

## Security and privacy

| Provider | Data sent |
|---|---|
| Tencent TokenHub | Email text and request metadata, to Tencent Cloud |

No tracking or analytics are included. Settings and the Tencent TokenHub API Key are stored in Thunderbird's local extension storage and are not encrypted by this add-on. The API Key is sent only in the HTTPS Authorization header and is never placed in the request body or local performance records.

Use a dedicated TokenHub API Key and configure budget alerts in Tencent Cloud as the authoritative usage guard; the extension's monthly counter only reflects API-reported token usage observed by this Thunderbird installation.

Network permission is limited to `https://tokenhub.tencentmaas.com/*`.

The MV2 `messagesModify` permission is required by Thunderbird's `messageDisplayScripts` API so the add-on can inject its content script into the rendered message. The add-on changes only the displayed DOM for translation and does not rewrite the stored email.

## Test and package

```powershell
node --test tests/*.test.js
./make_xpi.ps1
```

## Changelog

### v1.9.0

- Migrates text translation from the removed TMT `TextTranslate` catalog entry to TokenHub Hy-MT2.
- Defaults to latency-oriented `hy-mt2-lite`, with Plus and Pro selectable in settings.
- Batches message segments into one or a few bounded requests while preserving atomic commit and source order.
- Replaces legacy SecretId/SecretKey settings with a TokenHub API Key and token-based local usage visibility.

### v1.8.9

- Schedules the subject inside the same two-worker pool as the body, and translates duplicate plain-text segments only once per message.
- Batches local Tencent usage writes, caches settings safely, and avoids repeated badge styling during progress updates.
- Injects the content script into already-open messages after an add-on reload without triggering auto-translation.
- Stores content-free last-run performance metrics and replaces the retired Microsoft comparison in the live benchmark.

### v1.8.8

- Translates plain-text message nodes with at most two concurrent requests while preserving source order and atomic commit behavior.
- Retries Tencent `RequestLimitExceeded` responses twice with cancellable exponential backoff.

### v1.8.7

- Restores the MV2 `messagesModify` permission required by Thunderbird's `messageDisplayScripts` API.
- Adds a manifest contract test so packaging cannot silently disable the message content script again.

### v1.8.6

- Removes the retired no-key Microsoft adapter, endpoints, routing, settings UI, and runtime tests.
- Deletes legacy Microsoft target-language settings during the versioned settings migration.
- Keeps safe migration of retired provider selections to no provider and retains historical benchmark and changelog records.

### v1.8.5

- Requires explicit provider selection on fresh installs and migrates unavailable Microsoft selections to no provider.
- Disables the broken no-key Microsoft route and removes its host permissions.
- Stages body and subject translations and commits them atomically after full success.
- Adds bounded long-operation timeouts, progress reporting, and click-again cancellation for reading messages.
- Shows provider errors in the toolbar tooltip and an in-message error bar.
- Adds Simplified Chinese UI strings and provider-status guidance.
- Adds regression coverage for cancellation, runtime policy, endpoint failure, and atomic message updates.

### v1.8.4

- Limited the selectable and executable provider surface to Microsoft and Tencent.
- Migrates any retired saved provider selection to Microsoft.
- Uses provider-specific target-language menus and migrates unsupported saved targets to English.
- Distinguishes unsupported Tencent target languages from legacy API retirement errors.
- Removed unused provider configuration and narrowed network permissions.

### v1.8.3.3

- Changed the fresh-install default to Microsoft based on the blind email-quality benchmark.
- Added the reproducible benchmark corpus and report.

### v1.8.3.2

- Added Tencent API-reported usage tracking.

### v1.8.3.1

- Added Microsoft and Tencent translation providers.

## License

MIT
