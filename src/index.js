const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

function setOutput(runnersInfo) {
  core.setOutput('ec2-instance-id', runnersInfo.instanceId);
  core.setOutput('runners', runnersInfo.runners);
}

async function start() {
  const runnersInfo = await aws.startEc2Instance(config.input.githubToken);
  setOutput(runnersInfo);
  await aws.waitForInstanceRunning(runnersInfo);
  await gh.waitForRunnerRegistered(runnersInfo);
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
