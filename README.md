# claude-mods / Usage

[日本語](README.ja.md)

A Claude Code mod for Claude Desktop that shows your usage as one compact line under the prompt.

![The usage line beside the model picker in Claude Desktop](docs/screenshot.png)

```
usage c21 s77/3:39 w8
```

| Part | Meaning |
| --- | --- |
| `c21` | Context window used, % |
| `s77/3:39` | Current session (5-hour) limit used, %, and time until it resets (h:mm) |
| `w8` | Weekly (7-day) limit used, % |

For Claude Desktop (Code tab) only. It leaves the terminal (CLI) display unchanged. While the same session is open in both Claude Desktop and a terminal, it shows the line in neither.

A figure not reported is left out. The line refreshes after each turn and the reset countdown every minute.

The limits are the newest figures any Claude Code session on this machine has received: the sessions share them, so usage in another session shows up within about a minute. Usage elsewhere, such as claude.ai chats or another device, shows up only with the next response, so the line can read lower than Claude Desktop's own usage view.

## Install

Requires Claude Code 2.1.287 or later, the first release with mods (tested on 2.1.295).

1. In the Code tab of Claude Desktop, click **+** below the prompt box → **Add plugins**.
2. Click **+ Add** (top right) → **Add marketplace** → **Add from a repository**, enter `kkatsuyoshi/claude-mods`, and click **Sync**.
3. Click **Add** on **Usage** (if you can't find **Usage**, scroll down on the **Add plugins** screen and go to **On this computer** → **kkatsuyoshi**).

## Uninstall

1. In the Code tab of Claude Desktop, click **+** below the prompt box → **Add plugins**.
2. Scroll down and click **On this computer** → **kkatsuyoshi**.
3. Open the **…** menu to the right of **Usage** and click **Remove**.
