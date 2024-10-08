const AWS = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
/* eslint-disable no-useless-escape */
function buildUserDataScript(githubToken, runnerCount, generalLabels) {
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
set -x

function start_runner {
  export RUNNER_HOME="$\{ACTION_HOME\}/runner_$\{1\}"
  cd $RUNNER_HOME
  echo "Getting token to get metadata of EC2 instance"
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  echo Getting ec2 instance id
  export INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $\{TOKEN\}" -v http://169.254.169.254/latest/meta-data/instance-id)
  echo "Got instance id $\{INSTANCE_ID\}"
  export RUNNER_NAME="$\{INSTANCE_ID\}_runner_$\{1\}"
  echo "Runner name is $\{RUNNER_NAME\}"
  echo "Getting runner token"
  export RUNNER_TOKEN=$(curl -s -XPOST \
    -H "authorization: token ${githubToken}" \
    https://api.github.com/repos/${config.githubContext.owner}/${config.githubContext.repo}/actions/runners/registration-token | \
    jq -r .token)
  if [ -f ".runner" ]; then
    echo Unregistering old runner data
    su -p "action-user" -c bash -c "./config.sh remove --token $\{RUNNER_TOKEN\}"
  fi
  echo "Registering runner"
  su -p "action-user" -c bash -c './config.sh \
    --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} \
    --token $\{RUNNER_TOKEN\} \
    --labels "$\{INSTANCE_ID\},$\{RUNNER_NAME\},${generalLabels}" \
    --name "$\{RUNNER_NAME\}" \
    --unattended \
    --replace'

  echo "Starting runner"
  su -l "action-user" -c RUNNER_HOME=$RUNNER_HOME bash -c "cd $\{RUNNER_HOME\} && ./run.sh"
}

export ACTION_HOME="/home/action-user"
export RUNNER_VERSION="2.319.1"
case $(uname) in Darwin) OS="osx" ;; Linux) OS="linux" ;; esac && export RUNNER_OS=$\{OS\}
case $(uname -m) in aarch64|arm64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=$\{ARCH\}
if [ ! -f /var/lib/actions-runner.tar.gz ]; then
curl -L "https://github.com/actions/runner/releases/download/v$\{RUNNER_VERSION\}/actions-runner-$\{RUNNER_OS\}-$\{RUNNER_ARCH\}-$\{RUNNER_VERSION\}.tar.gz" \
  -o /var/lib/actions-runner.tar.gz
fi
if [ ! -d "$\{ACTION_HOME\}" ]; then
  groupadd "action-user"
  useradd -m -d $ACTION_HOME -s $(which bash) -g "action-user" "action-user"
  echo "action-user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/action-user-sudo-no-passwd
  command -v yum >/dev/null 2>&1 \
    && { echo "Installing dependencies with yum"; \
      command -v jq >/dev/null 2>&1 || sudo yum -y install jq; \
      command -v git >/dev/null 2>&1 || sudo yum -y install git; }
  command -v apt-get >/dev/null 2>&1 \
    && { echo "Installing dependencies with apt-get"; \
      sudo apt-get update -qq >/dev/null; \
      command -v jq >/dev/null 2>&1 || sudo apt-get install -y jq; \
      command -v git >/dev/null 2>&1 || sudo apt-get install -y git; }
  command -v docker \
  || { curl -fsSL https://get.docker.com -o get-docker.sh; \
      sudo sh get-docker.sh; }
  echo "Setup docker for non-root user"
  groupadd docker
  usermod -aG docker "action-user"
  echo "Installing runner"
  for i in $(seq 1 ${runnerCount}); do
    mkdir -p "$\{ACTION_HOME\}/runner_$\{i\}"
    tar xzf "/var/lib/actions-runner.tar.gz" -C "$\{ACTION_HOME\}/runner_$\{i\}"
  done
  chown -R "action-user:action-user" $ACTION_HOME
fi

for i in $(seq 1 ${runnerCount}); do
  start_runner $i &
done
wait
--//--`;
}

function getRunnersInfo(instanceId) {
  const info = {
    instanceId: instanceId,
    runners: [],
  };
  for (let i = 1; i <= config.input.runnerCount; i++) {
    info.runners.push(`${instanceId}_runner_${i}`);
  }
  return info;
}

async function startEc2Instance(githubToken) {
  const ec2 = new AWS.EC2();
  const tagsFilters = [];
  let instanceId = null;
  const generalLabels = [];

  for (const tag of config.tagSpecifications) {
    tagsFilters.push({ Name: `tag:${tag.Key}`, Values: [tag.Value] });
    generalLabels.push(tag.Value);
  }

  const userData = buildUserDataScript(githubToken, config.input.runnerCount, generalLabels.join(','));

  const runParams = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    BlockDeviceMappings: [
      {
        DeviceName: config.input.ec2VolumeMountPoint,
        Ebs: {
          DeleteOnTermination: true,
          VolumeSize: config.input.ec2VolumeSize,
          VolumeType: 'gp3',
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
    InstanceInitiatedShutdownBehavior: config.input.reuseRunner === 'true' ? 'stop' : 'terminate',
    InstanceMarketOptions: {
      MarketType: 'spot',
      SpotOptions: {
        InstanceInterruptionBehavior: config.input.reuseRunner === 'true' ? 'stop' : 'terminate',
        SpotInstanceType: config.input.reuseRunner === 'true' ? 'persistent' : 'one-time',
      },
    },
  };

  const startParams = {
    InstanceIds: [],
  };
  if (config.input.reuseRunner === 'true') {
    const describeParams = {
      Filters: [
        ...tagsFilters,
        { Name: 'instance-state-name', Values: ['stopped'] },
        { Name: 'instance-type', Values: [config.input.ec2InstanceType] },
        { Name: 'image-id', Values: [config.input.ec2ImageId] },
      ],
    };

    core.info(`Checking for stopped instance with filter ${JSON.stringify(describeParams)}`);

    try {
      const result = await ec2.describeInstances(describeParams);
      if (
        result.Reservations !== null &&
        result.Reservations.length > 0 &&
        result.Reservations[0].Instances[0].State.Name !== 'terminated'
      ) {
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

  if (config.input.reuseRunner === 'true' && startParams.InstanceIds.length > 0) {
    try {
      const result = await ec2.startInstances(startParams);
      const ec2InstanceId = result.StartingInstances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is starting`);
      return getRunnersInfo(ec2InstanceId);
    } catch (error) {
      core.warning('AWS EC2 instance starting error');
      core.warning(`${error.name}: ${error.message}`);
      if (error.name.indexOf('InsufficientInstanceCapacity') >= 0) {
        delete runParams.InstanceMarketOptions;
      } else if (error.name.indexOf('IncorrectSpotRequestState') >= 0) {
        runParams.InstanceInitiatedShutdownBehavior = 'terminate';
        runParams.InstanceMarketOptions = {
          MarketType: 'spot',
          SpotOptions: {
            InstanceInterruptionBehavior: 'terminate',
            SpotInstanceType: 'one-time',
          },
        };
      } else {
        throw error;
      }
    }
  }

  let lastError = null;
  for (let i = 0; i < 2; i++) {
    try {
      const result = await ec2.runInstances(runParams);
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is starting`);
      return getRunnersInfo(ec2InstanceId);
    } catch (error) {
      core.warning('AWS EC2 instance starting error');
      core.warning(`${error.name}: ${error.message}`);
      lastError = error;
      if (error.name.indexOf('InsufficientInstanceCapacity') >= 0) {
        delete runParams.InstanceMarketOptions;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
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
  } catch (error) {
    core.warning(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    core.warning(`${error.name}: ${error.message}`);
    if (error.name.indexOf('UnsupportedOperation') < 0) {
      throw error;
    }
  }

  const spotRequestQuery = {
    Filters: [{ Name: 'instance-id', Value: [config.input.ec2InstanceId] }],
  };
  const result = await ec2.describeSpotInstanceRequests(spotRequestQuery);
  if (result.SpotInstanceRequests !== null && result.SpotInstanceRequests.length > 0) {
    const spotCancelRequest = {
      SpotInstanceRequestIds: result.SpotInstanceRequests.map((x) => x.SpotInstanceRequestId),
    };

    await ec2.cancelSpotInstanceRequests(spotCancelRequest);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated along with its spot request`);
    return;
  }

  await ec2.terminateInstances(params);
  core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
}

async function waitForInstanceRunning(runnersInfo) {
  const ec2 = new AWS.EC2();
  const ec2InstanceId = runnersInfo.instanceId;

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await AWS.waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, params);
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
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
