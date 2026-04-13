# VibeCoding News

## Deployment

This repo now includes a Firebase Hosting deployment workflow for the React frontend.

### What it does

- Builds the app with `npm run build`
- Deploys the `build/` output to Firebase Hosting
- Targets Firebase project `coreaee-65e7f`

### GitHub Actions workflows

- `.github/workflows/update-news.yml`
  - Updates Firestore briefing data
- `.github/workflows/deploy-hosting.yml`
  - Deploys the frontend to Firebase Hosting on push to `master`

### Required GitHub secret

- `FIREBASE_SERVICE_ACCOUNT`
  - Must be a JSON service account key with permission to deploy Firebase Hosting

Recommended roles:

- `Firebase Hosting Admin`
- `Viewer`

If the same service account is also used by `scripts/update_data.py`, it also needs Firestore access.

### Manual deploy

```bash
npm ci
npm run build
npx firebase-tools deploy --only hosting --project coreaee-65e7f
```
