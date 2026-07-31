# Thunderbird Translator

**Email translation with Microsoft Translator and Tencent Cloud Translation**

This is a focused fork of [jctots/thunderbird-translator](https://github.com/jctots/thunderbird-translator), itself forked from [zoott28354/thunderbird-translator](https://github.com/zoott28354/thunderbird-translator).

## Features

- **Microsoft Translator** — zero-configuration default
- **Tencent Cloud Translation** — optional credentialed provider, selected manually
- **Tencent usage visibility** — records API-reported characters used by this Thunderbird installation each month
- Translate received email inline and restore it with one click
- Translate selected text while composing
- Optional automatic translation
- 15 target languages
- Per-provider target-language preferences

## Requirements

- Thunderbird 128 or later
- Tencent `SecretId` and `SecretKey` only when Tencent is selected

## Installation

1. Open Thunderbird Add-ons Manager.
2. Choose **Install Add-on From File** from the gear menu.
3. Select the generated `.xpi` file and confirm.

For temporary development loading, open **Debug Add-ons**, choose **Load Temporary Add-on**, and select `manifest.json`.

## Configuration

Microsoft is the fresh-install default and requires no local configuration. Message content is sent to Microsoft's translation service.

Tencent requires `SecretId`, `SecretKey`, `Region`, and `ProjectId`. The Options page can import these values once from a user-selected Zotero `prefs.js` file. The selected file is not retained or uploaded. Tencent is never selected automatically and is never used as a fallback.

### Provider selection

The reproducible corpus in [`benchmarks/translation-quality-cases.json`](benchmarks/translation-quality-cases.json) covers academic notices, antenna engineering, peer review, scheduling, formatting, extension requests, technical argumentation, and procurement instructions.

In the 2026-07-31 blind run:

- Microsoft won 5 of 8 cases and all 3 Chinese-to-English cases.
- Tencent was marginally stronger for English-to-Chinese overall and preserved numbers and symbols better, but was less fluent.
- Use Microsoft as the general default and for Chinese-to-English composing.
- Consider Tencent for English-to-Chinese technical reading when symbol fidelity is especially important.
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
| Microsoft Translator | Email text, to Microsoft translation endpoints |
| Tencent Cloud Translation | Email text and request metadata, to Tencent Cloud |

No tracking or analytics are included. Settings and Tencent credentials are stored in Thunderbird's local extension storage and are not encrypted by this add-on. The Tencent `SecretKey` is used locally to sign requests and is not placed in the request.

Network permissions are limited to these endpoints:

- `https://edge.microsoft.com/*`
- `https://api-edge.cognitive.microsofttranslator.com/*`
- `https://tmt.tencentcloudapi.com/*`

## Test and package

```powershell
node --test tests/providers.test.js tests/translation-router.test.js
./make_xpi.ps1
```

## Changelog

### v1.8.4

- Limited the selectable and executable provider surface to Microsoft and Tencent.
- Migrates any retired saved provider selection to Microsoft.
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
