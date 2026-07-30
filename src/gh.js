const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');

async function getLatestRunnerVersion() {
  const defaultVersion = '2.336.0';
  try {
    const octokit = github.getOctokit(config.input.githubToken);
    const release = await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
      owner: 'actions',
      repo: 'runner',
    });
    if (release && release.data && release.data.tag_name) {
      const version = release.data.tag_name.replace(/^v/, '');
      core.info(`Fetched latest GitHub Actions runner version: ${version}`);
      return version;
    }
  } catch (error) {
    core.warning(`Failed to fetch latest runner version from GitHub API (${error.message}), falling back to default v${defaultVersion}`);
  }
  return defaultVersion;
}

// use the unique ec2-instance-id to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunners(ec2InstanceId) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const runners = await octokit.paginate(
      'GET /repos/{owner}/{repo}/actions/runners',
      Object.assign({}, config.githubContext, { per_page: 100 })
    );
    const matches = _.filter(runners, (runner) => {
      return runner.labels && runner.labels.some((l) => l.name === ec2InstanceId);
    });
    return matches.length > 0 ? matches : null;
  } catch (error) {
    core.warning(`GitHub API error while getting runners: ${error.message}`);
    return null;
  }
}

async function removeRunner() {
  const runners = await getRunners(config.input.ec2InstanceId);
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runners) {
    core.info(`GitHub self-hosted runner with name ${config.input.ec2InstanceId} is not found, so the removal is skipped`);
    return;
  }

  try {
    for (const runner of runners) {
      await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', Object.assign({}, config.githubContext, { runner_id: runner.id }));
      core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    }
    return;
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

module.exports = {
  getLatestRunnerVersion,
  getRunners,
  removeRunner,
};
