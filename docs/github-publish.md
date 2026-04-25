# Publish To GitHub

## Initialize

```bash
git init
git checkout -b main
git add .
git commit -m "feat: initial codex2web release"
```

## Bind Remote

```bash
git remote add origin https://github.com/hanyz110/codex2web.git
```

## Push

```bash
git push -u origin main
```

## If Push Fails

Typical reasons:

1. GitHub credentials are not configured on this machine
2. the repository does not exist yet
3. your account does not have write access

Recommended fixes:

1. authenticate with GitHub CLI or credential manager
2. confirm the target repository exists
3. retry the push
