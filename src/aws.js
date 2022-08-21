const AWS = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
/* eslint-disable no-useless-escape */
function buildUserDataScript(githubToken) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return `Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [scripts-user, always]

--//
Content-Type: text/x-shellscript; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="userdata.txt"

#!/bin/bash
cd "${config.input.runnerHomeDir}"

echo Getting token to get metadata of EC2 instance
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
echo Getting ec2 instance id
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $\{TOKEN\}" -v http://169.254.169.254/latest/meta-data/instance-id)
echo Got instance id $INSTANCE_ID

echo Getting runner token
RUNNER_TOKEN=$(curl -s -XPOST \
  -H "authorization: token ${githubToken}" \
  https://api.github.com/repos/${config.githubContext.owner}/${config.githubContext.repo}/actions/runners/registration-token | \
  jq -r .token)
if [ -f ".runner" ]; then
  echo Unregistering old runner data
  ./config.sh remove --token $RUNNER_TOKEN
fi
echo Registering runner
./config.sh \
  --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} \
  --token $RUNNER_TOKEN \
  --labels $INSTANCE_ID \
  --name $INSTANCE_ID \
  --work _work

echo Starting runner
./run.sh
--//--`;
  } else {
    return `Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [scripts-user, always]

--//
Content-Type: text/x-shellscript; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="userdata.txt"

#!/bin/bash
export RUNNER_ALLOW_RUNASROOT=1
if [ ! -d "./actions-runner" ]; then
  command -v yum >/dev/null 2>&1 \
    && { echo "Installing dependencies with yum"; \
      sudo yum -y install libicu60 jq git; }
  command -v apt-get >/dev/null 2>&1 \
    && { echo "Installing dependencies with apt-get"; \
      sudo apt-get install -y jq git; }
  curl -fsSL https://get.docker.com -o get-docker.sh; \
    sudo sh get-docker.sh;
  echo Installing runner
  mkdir -p actions-runner
  cd actions-runner
  case $(uname) in Darwin) OS="osx" ;; Linux) OS="linux" ;; esac && export RUNNER_OS=$\{OS\}
  case $(uname -m) in aarch64|arm64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=$\{ARCH\}
  curl -O -L https://github.com/actions/runner/releases/download/v2.295.0/actions-runner-$\{RUNNER_OS\}-$\{RUNNER_ARCH\}-2.295.0.tar.gz
  tar xzf ./actions-runner-linux-$\{RUNNER_ARCH\}-2.295.0.tar.gz
else
  cd actions-runner
fi

echo Getting token to get metadata of EC2 instance
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
echo Getting ec2 instance id
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $\{TOKEN\}" -v http://169.254.169.254/latest/meta-data/instance-id)
echo Got instance id $INSTANCE_ID

echo Getting runner token
RUNNER_TOKEN=$(curl -s -XPOST \
  -H "authorization: token ${githubToken}" \
  https://api.github.com/repos/${config.githubContext.owner}/${config.githubContext.repo}/actions/runners/registration-token | \
  jq -r .token)
if [ -f ".runner" ]; then
  echo Unregistering old runner data
  ./config.sh remove --token $RUNNER_TOKEN
fi
echo Registering runner
./config.sh \
  --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} \
  --token $RUNNER_TOKEN \
  --labels $INSTANCE_ID \
  --name $INSTANCE_ID \
  --work _work

echo Starting runner
./run.sh
--//--`;
  }
}

async function startEc2Instance(githubToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubToken);

  const runParams = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/sda1',
        Ebs: {
          DeleteOnTermination: true,
          VolumeSize: 32,
          VolumeType: 'gp2',
        },
      },
    ],
    UserData: Buffer.from(userData).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: [
      { ResourceType: 'instance', Tags: config.tagSpecifications },
      { ResourceType: 'volume', Tags: config.tagSpecifications },
    ],
    InstanceInitiatedShutdownBehavior: 'stop',
  };

  const startParams = {
    InstanceIds: [],
  };
  if (config.input.reuseRunner === 'true') {
    const tagsFilters = [];
    let instanceId = null;

    for (const tag of config.tagSpecifications) {
      tagsFilters.push({ Name: `tag:${tag.Key}`, Values: [tag.Value] });
    }
    const describeParams = {
      Filters: [...tagsFilters, { Name: 'instance-state-name', Values: ['stopped'] }],
    };

    core.info(`Checking for stopped instance with filter ${JSON.stringify(describeParams)}`);

    try {
      const result = await ec2.describeInstances(describeParams);
      if (result.Reservations !== null && result.Reservations.length > 0 && result.Reservations[0].Instances[0].State.Name !== 'terminated') {
        instanceId = result.Reservations[0].Instances[0].InstanceId;
      }
      if (instanceId !== null && instanceId !== undefined) {
        startParams.InstanceIds.push(instanceId);
      }
    } catch (error) {
      core.error('Failed to check for hibernated instance');
      throw error;
    }
  }

  try {
    if (config.input.reuseRunner === 'true' && startParams.InstanceIds.length > 0) {
      const result = await ec2.startInstances(startParams);
      const ec2InstanceId = result.StartingInstances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is starting`);
      return ec2InstanceId;
    }
    const result = await ec2.runInstances(runParams);
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is starting`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    if (config.input.reuseRunner === 'true') {
      await ec2.stopInstances(params);
      core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is stopped`);
      return;
    }
    await ec2.terminateInstances(params);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await AWS.waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, params);
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
