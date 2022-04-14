const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

function setOutput(ec2InstanceId) {
  core.setOutput('ec2-instance-id', ec2InstanceId);
}

async function start() {
  const ec2InstanceId = await aws.startEc2Instance(config.input.githubToken);
  setOutput(ec2InstanceId);
  await aws.waitForInstanceRunning(ec2InstanceId);
  await gh.waitForRunnerRegistered(ec2InstanceId);
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
