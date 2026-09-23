# agent-box

Files that live on the claude-code agent box rather than in this process.

`skills/` is installed to `/data/home/.claude/skills/` on the box, which is on the volume and survives
restarts. `fixing-review-feedback` is written here; `receiving-code-review` and
`verification-before-completion` are vendored unchanged from obra/superpowers under its MIT licence.
