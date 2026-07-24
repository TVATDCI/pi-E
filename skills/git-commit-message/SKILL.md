---
name: git-commit-message
description: |
  Use this skill when the user specifically needs to draft, write, or generate
  git commit message content. This includes composing new commit messages from
  staged diffs, rewriting or improving existing commit messages, or determining
  what message to use for pending changes. Produces descriptive text following
  conventional commit format. Do NOT use for revert operations, branch
  management, merging, rebasing, or other git workflows unrelated to crafting
  commit message text. Triggers: "commit message", "write a commit", "staged
  diff", "what should I commit".
---

# Git Commit Message Assistant

This skill helps write high-quality git commit messages by analyzing staged
changes and generating an appropriate message in conventional-commit format.

> **pi workflow note.** This skill only DRAFTS the message. The actual gated
> `git add` + `git commit` is performed by the **interactive parent**, which
> surfaces the `🛡️ SAFETY CONFIRM` modal for the operator — or, for small
> commits, the agent hands the operator the exact commands to run. An agent
> must NEVER `git push`; push is operator-only. (seraph is the
> `git-commit-message` category operative and can be dispatched to draft.)

## Guidelines

### Analyzing changes
1. Check what is staged: `git diff --cached --name-only`
2. Read the actual diff: `git diff --cached` to understand the changes
3. Identify the scope: is this a feature, fix, docs, style, refactor, test, or chore?

### Message format
Use conventional commit format:

```
<type>(<scope>): <short description>

<body explaining what and why>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only changes
- `style`: Code style changes (formatting, semicolons, etc.)
- `refactor`: Code changes that neither fix bugs nor add features
- `test`: Adding or correcting tests
- `chore`: Build process or auxiliary tooling changes

### Body guidelines
- Use present tense ("Add feature" not "Added feature")
- Be specific about what changed
- Explain *why* the change was made, not just what
- Keep the first line under 50 characters
- Wrap the body at 72 characters

## Example

**Task:** Write a commit message for the staged changes.

```bash
git diff --cached --name-only
```

[Analyze files… read the diff…]

Based on changes to `src/auth.js` and `src/utils/token.js`:

```
feat(auth): implement JWT token refresh mechanism

Add automatic token refresh to auth middleware to handle expired
access tokens transparently. Includes:
- Token expiry detection in request interceptor
- Background refresh without user interruption
- Graceful fallback to login on refresh failure

Fixes edge case where users were logged out unexpectedly
after 24h token expiration.
```

## Edge cases
- If nothing is staged, suggest `git add` first.
- If changes span multiple concerns, suggest splitting into multiple commits.
- For WIP commits, suggest marking them as such and explain cleanup later.
