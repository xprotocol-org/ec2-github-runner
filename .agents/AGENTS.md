# Rules

- **Never use AWS EC2 serial console inspection (`getConsoleOutput`)** for instance status, readiness, or health checks as EC2 serial console logs are super delayed.
- **Never poll GitHub API early for runner readiness (`attempt > 36`)**. GitHub API is heavily rate-limited across organization workflows. Always rely on EC2 instance status tags (`RunnerStatus=online`) for fast readiness checks, and only fallback to GitHub API after at least 3 minutes (`attempt > 36`).
