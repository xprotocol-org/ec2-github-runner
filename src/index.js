const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

function setOutput(runnersInfo) {
  core.setOutput('ec2-instance-id', runnersInfo.instanceId);
  core.setOutput('runners', runnersInfo.runners);
}

async function start() {
  const runnerVersion = await gh.getLatestRunnerVersion();
  let runnersInfo;
  try {
    runnersInfo = await aws.startEc2Instance(config.input.githubToken, runnerVersion);
    setOutput(runnersInfo);
    await aws.waitForInstanceRunning(runnersInfo);
    await aws.waitForRunnerReady(runnersInfo);
  } catch (error) {
    if (runnersInfo && runnersInfo.instanceId) {
      core.warning(`Initialization failed. Attempting cleanup for EC2 instance ${runnersInfo.instanceId}...`);
      try {
        await aws.terminateEc2Instance(runnersInfo.instanceId, true);
        core.info(`Cleaned up EC2 instance ${runnersInfo.instanceId}`);
      } catch (cleanupError) {
        core.error(`CRITICAL: Failed to automatically terminate EC2 instance ${runnersInfo.instanceId} due to AWS error: ${cleanupError.message}. Please terminate this instance manually in the AWS Console.`);
      }
    }
    throw error;
  }
}

async function stop() {
  await aws.terminateEc2Instance();
  await gh.removeRunner();
}

(async function () {
  try {
    config.input.mode === 'start' ? await start() : await stop();
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
})();
