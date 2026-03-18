# OpenCode Truncation-Retry Plugin

This plugin automatically detects and retries truncated assistant responses in OpenCode. It uses a small-model classifier to distinguish between natural completions and cut-off thoughts, ensuring a seamless experience while maintaining safety boundaries.

## Features

- **Automated Detection**: Classifies assistant turns into `normal`, `truncated`, or `maybe-truncated-needs-judgment`.
- **Safe Replay**: Automatically reverts and replays confirmed safe truncations up to a configurable budget.
- **Safety Guardrails**: Escalates to user judgment if side effects are detected, the retry budget is exhausted, or truncation is ambiguous.
- **Atomic Rollback**: If a replay submission fails, the plugin rolls back the session state using `unrevert` to prevent data loss.

## How it Works

1. **Detection**: On every assistant turn, the plugin checks the `finishReason` and content.
2. **Classification**: If the turn looks suspicious, it calls a configured small model (e.g., via an OpenAI-compatible endpoint) to judge if it was truncated.
3. **Safety Check**: Before retrying, the plugin inspects the turn for side effects (like tool calls). Turns with side effects are never auto-retried.
4. **Execution**: If safe, the plugin reverts the last message and resubmits the prompt.
5. **Escalation**: For ambiguous cases or failures, it uses `tui.showToast()` and `tui.appendPrompt()` to notify the user and request manual review.

## Configuration

### Plugin Behavior (src/config.ts)

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_PLUGIN_RETRY_ENABLED` | Set to `false` to disable the plugin. | `true` |
| `OPENCODE_PLUGIN_RETRY_MAX_RETRIES` | Max auto-retries per root user prompt (capped at 2). | `2` |
| `OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS` | Timeout for the classifier request. | `5000` |

### Classifier Endpoint

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT` | OpenAI-compatible API endpoint for the classifier. | (Required unless disabled) |
| `OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL` | Model ID to use for classification. | (Required unless disabled) |
| `OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY` | API key for the classifier endpoint. | (Required unless disabled) |

### Replay Server Authentication

If your OpenCode server requires Basic auth for replay submissions:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_SERVER_PASSWORD` | Password for Basic authentication. | - |
| `OPENCODE_SERVER_USERNAME` | Username for Basic authentication. | `opencode` |

## Installation & Local Usage

### 1. Build the Plugin
```bash
bun run build
```

### 2. Supported Load Paths

OpenCode supports two primary ways to load this plugin:

#### Path A: Local Plugin File (Auto-loaded)
Create a thin wrapper file in one of the following directories. OpenCode **automatically loads** all `.js` files in these locations:
- Project-local: `./.opencode/plugins/`
- User-global: `~/.config/opencode/plugins/`

**Example `~/.config/opencode/plugins/retry-plugin.js`**:
```javascript
// Import the built distribution from this repository
import plugin from '/path/to/opencode-retry/dist/index.js';
export default plugin;
```

#### Path B: NPM Package (Config-loaded)
If you install the plugin as a package (e.g. via `.opencode/package.json`), you must register it in your project's `opencode.json` (or `opencode.jsonc`) using the **singular** `plugin` key:

```json
{
  "plugin": [
    "opencode-plugin-starter"
  ]
}
```
*(Note: The current package name is `opencode-plugin-starter`.)*

## Development & Verification

To verify the plugin locally:

```bash
bun run build      # Clean and build to dist/
bun test           # Run unit tests
npm pack --dry-run # Verify packaging metadata
```

## Limitations

- **User Judgment**: The plugin cannot create new user questions/modals due to API limitations. It uses toasts and prompt appending for escalation.
- **Truncation Accuracy**: Detection is heuristic and depends on the classifier model's quality.
- **Side Effects**: Only simple text turns are auto-retried; any turn with completed tool calls is considered unsafe.
