const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');

// use the unique ec2-instance-id to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunners(ec2InstanceId) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    const foundRunners = _.filter(runners, { labels: [{ name: ec2InstanceId }] });
    return foundRunners.length > 0 ? foundRunners : null;
  } catch (error) {
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
      await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', _.merge(config.githubContext, { runner_id: runner.id }));
      core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    }
    return;
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

async function waitForRunnerRegistered(runnersInfo) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 10;
  const quietPeriodSeconds = 30;
  const ec2InstanceId = runnersInfo.instanceId;
  const waitSeconds = 0;

  core.info(`Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`);
  await new Promise((r) => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const runners = await getRunners(ec2InstanceId);

      if (waitSeconds > timeoutMinutes * 60) {
        core.error('GitHub self-hosted runner registration error');
        clearInterval(interval);
        reject(
          `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`
        );
      }

      if (!runners) {
        core.info("Don't see any runner yet. Waiting...");
        return;
      }

      core.info(`Found runners ${JSON.stringify(runners)}`);
      const readyRunners = runners.filter((runner) => runnersInfo.runners.indexOf(runner.name) >= 0).filter((runner) => runner.status === 'online');
      core.info(`Found ready runners ${JSON.stringify(readyRunners)}`);
      if (readyRunners.length < config.input.runnerCount) {
        core.info('Not all runners are ready. Waiting...');
        return;
      }

      for (const runner of runners) {
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
      }
      clearInterval(interval);
      resolve();
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  removeRunner,
  waitForRunnerRegistered,
};
