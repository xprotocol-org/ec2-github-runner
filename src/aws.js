const AWS = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const config = require('./config');
const gh = require('./gh');

const TAG_REUSE_RUNNER = 'ReuseRunner';
const TAG_RUNNER_STATUS = 'RunnerStatus';
const RUNNER_STATUS_ONLINE = 'online';

// User data scripts are run as the root user
/* eslint-disable no-useless-escape */
function buildUserDataScript(githubToken, runnerCount, generalLabels, runnerVersion = '2.336.0', awsCreds = null, awsRegion = '') {
  let awsCredsEnv = '';
  if (awsCreds && awsCreds.accessKeyId && awsCreds.secretAccessKey) {
    awsCredsEnv = `
          # EXPORT_GH_TOKEN="${githubToken}"
          # EXPORT_AWS_ACCESS_KEY_ID="${awsCreds.accessKeyId}"
          # EXPORT_AWS_SECRET_ACCESS_KEY="${awsCreds.secretAccessKey}"
          # EXPORT_AWS_SESSION_TOKEN="${awsCreds.sessionToken || ''}"
          export AWS_ACCESS_KEY_ID="${awsCreds.accessKeyId}"
          export AWS_SECRET_ACCESS_KEY="${awsCreds.secretAccessKey}"
          ${awsCreds.sessionToken ? `export AWS_SESSION_TOKEN="${awsCreds.sessionToken}"` : ''}`;
  } else {
    awsCredsEnv = `
          # EXPORT_GH_TOKEN="${githubToken}"`;
  }

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
  TOKEN=$(curl -s -f --connect-timeout 5 --retry 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  echo Getting ec2 instance id
  export INSTANCE_ID=$(curl -s -f --connect-timeout 5 --retry 3 -H "X-aws-ec2-metadata-token: $\{TOKEN\}" http://169.254.169.254/latest/meta-data/instance-id)
  echo "Got instance id $\{INSTANCE_ID\}"
  export RUNNER_NAME="$\{INSTANCE_ID\}_runner_$\{1\}"
  echo "Runner name is $\{RUNNER_NAME\}"

  RAW_UD=$(curl -s -f --connect-timeout 5 --retry 3 -H "X-aws-ec2-metadata-token: $\{TOKEN\}" http://169.254.169.254/latest/user-data 2>/dev/null)
  DYNAMIC_GH=$(echo "$RAW_UD" | grep -m 1 '^ *# EXPORT_GH_TOKEN=' | cut -d'"' -f2)
  EFF_GH_TOKEN="$\{DYNAMIC_GH:-${githubToken}\}"

  echo "Getting runner token"
  export RUNNER_TOKEN=$(curl -s -XPOST \
    -H "authorization: token $\{EFF_GH_TOKEN\}" \
    https://api.github.com/repos/${config.githubContext.owner}/${config.githubContext.repo}/actions/runners/registration-token | \
    jq -r .token)
  if [ -z "$RUNNER_TOKEN" ] || [ "$RUNNER_TOKEN" = "null" ]; then
    echo "ERROR: Failed to fetch valid runner registration token from GitHub API" >&2
    exit 1
  fi
  if [ -f ".runner" ]; then
    echo Unregistering old runner data
    su -p "action-user" -c "cd $\{RUNNER_HOME\} && ./config.sh remove --token $\{RUNNER_TOKEN\}"
  fi
  echo "Registering runner"
  su -p "action-user" -c "cd $\{RUNNER_HOME\} && ./config.sh \
    --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} \
    --token $\{RUNNER_TOKEN\} \
    --labels \"$\{INSTANCE_ID\},$\{RUNNER_NAME\},${generalLabels}\" \
    --name \"$\{RUNNER_NAME\}\" \
    --unattended \
    --replace"

  echo "Starting runner"
  rm -rf "$\{RUNNER_HOME\}/_diag/*"
  su - "action-user" -c "cd $\{RUNNER_HOME\} && nohup ./run.sh > runner.log 2>&1 &"

  echo "Waiting for runner $\{RUNNER_NAME\} to connect to GitHub Actions..."
  for j in $(seq 1 60); do
    LATEST_LOG=$(ls -t $\{RUNNER_HOME\}/_diag/Runner_*.log 2>/dev/null | head -n 1)
    if [ -n "$LATEST_LOG" ] && grep -q "Listening for Jobs" "$LATEST_LOG" 2>/dev/null; then
      echo "Runner $\{RUNNER_NAME\} connected successfully!"
      echo "RUNNER_STATUS_ONLINE" > /dev/console 2>/dev/null
      echo "RUNNER_STATUS_ONLINE" > /dev/ttyS0 2>/dev/null
      echo "RUNNER_STATUS_ONLINE" > /dev/ttyAMA0 2>/dev/null
      DYNAMIC_AK=$(echo "$RAW_UD" | grep -m 1 '^ *# EXPORT_AWS_ACCESS_KEY_ID=' | cut -d'"' -f2)
      DYNAMIC_SK=$(echo "$RAW_UD" | grep -m 1 '^ *# EXPORT_AWS_SECRET_ACCESS_KEY=' | cut -d'"' -f2)
      DYNAMIC_ST=$(echo "$RAW_UD" | grep -m 1 '^ *# EXPORT_AWS_SESSION_TOKEN=' | cut -d'"' -f2)
      if [ -n "$DYNAMIC_AK" ]; then export AWS_ACCESS_KEY_ID="$DYNAMIC_AK"; fi
      if [ -n "$DYNAMIC_SK" ]; then export AWS_SECRET_ACCESS_KEY="$DYNAMIC_SK"; fi
      if [ -n "$DYNAMIC_ST" ]; then export AWS_SESSION_TOKEN="$DYNAMIC_ST"; fi
      if ! command -v aws >/dev/null 2>&1; then
        command -v apt-get >/dev/null 2>&1 && sudo apt-get update -qq >/dev/null && sudo apt-get -o DPkg::Lock::Timeout=60 install -y awscli >/dev/null 2>&1
        command -v yum >/dev/null 2>&1 && sudo yum -y install awscli >/dev/null 2>&1
        command -v dnf >/dev/null 2>&1 && sudo dnf -y install awscli >/dev/null 2>&1
      fi
      if command -v aws >/dev/null 2>&1; then
        (
${awsCredsEnv}
          export AWS_DEFAULT_REGION="${awsRegion}"
          aws ec2 create-tags --resources $\{INSTANCE_ID\} --tags Key=RunnerStatus,Value=online ${awsRegion ? `--region "${awsRegion}"` : ''}
        )
      fi
      break
    fi
    sleep 2
  done
}

ensure_aws_cli() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "Installing AWS CLI..."
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update -qq >/dev/null && sudo apt-get -o DPkg::Lock::Timeout=60 install -y awscli
    elif command -v yum >/dev/null 2>&1; then
      sudo yum -y install awscli
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf -y install awscli
    fi
  fi
}
ensure_aws_cli

export ACTION_HOME="/home/action-user"
export RUNNER_VERSION="${runnerVersion}"
case $(uname) in Darwin) OS="osx" ;; Linux) OS="linux" ;; esac && export RUNNER_OS=$\{OS\}
case $(uname -m) in aarch64|arm64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=$\{ARCH\}
INSTALLED_VERSION=""
if [ -f /var/lib/actions-runner.version ]; then
  INSTALLED_VERSION=$(cat /var/lib/actions-runner.version)
fi
if [ ! -f /var/lib/actions-runner.tar.gz ] || [ "$\{INSTALLED_VERSION\}" != "$\{RUNNER_VERSION\}" ]; then
  echo "Downloading GitHub runner v$\{RUNNER_VERSION\}..."
  curl -L "https://github.com/actions/runner/releases/download/v$\{RUNNER_VERSION\}/actions-runner-$\{RUNNER_OS\}-$\{RUNNER_ARCH\}-$\{RUNNER_VERSION\}.tar.gz" \
    -o /var/lib/actions-runner.tar.gz
  echo "$\{RUNNER_VERSION\}" > /var/lib/actions-runner.version
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
      command -v jq >/dev/null 2>&1 || sudo apt-get -o DPkg::Lock::Timeout=60 install -y jq; \
      command -v git >/dev/null 2>&1 || sudo apt-get -o DPkg::Lock::Timeout=60 install -y git; }
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

mkdir -p /var/lib/cloud/scripts/per-boot
cat << 'EOF_PER_BOOT' > /var/lib/cloud/scripts/per-boot/start-runner.sh
#!/bin/bash
set -x
echo "Executing EC2 GitHub Runner Per-Boot Handler..."
TOKEN=$(curl -s -f --connect-timeout 5 --retry 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
RAW_UD=$(curl -s -f --connect-timeout 5 --retry 3 -H "X-aws-ec2-metadata-token: $\{TOKEN\}" http://169.254.169.254/latest/user-data 2>/dev/null)

SHELL_SCRIPT=$(echo "$RAW_UD" | awk '/^#!\\/bin\\/bash/{p=1} p' | sed '/^--\\/\\//q' | grep -v '^--\\/\\/')

if [ -z "$SHELL_SCRIPT" ]; then
  DECODED_UD=$(echo "$RAW_UD" | base64 -d 2>/dev/null)
  if [ -n "$DECODED_UD" ]; then
    SHELL_SCRIPT=$(echo "$DECODED_UD" | awk '/^#!\\/bin\\/bash/{p=1} p' | sed '/^--\\/\\//q' | grep -v '^--\\/\\/')
  fi
fi

if [ -n "$SHELL_SCRIPT" ]; then
  echo "$SHELL_SCRIPT" > /tmp/latest_userdata.sh
  chmod +x /tmp/latest_userdata.sh
  /bin/bash /tmp/latest_userdata.sh
fi
EOF_PER_BOOT

chmod +x /var/lib/cloud/scripts/per-boot/start-runner.sh

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

async function startEc2Instance(githubToken, runnerVersion = '2.336.0') {
  const ec2 = new AWS.EC2();
  let awsCreds = null;
  try {
    awsCreds = await ec2.config.credentials();
  } catch (error) {
    core.warning(`Failed to retrieve AWS credentials for user-data tagging: ${error ? error.message : error}`);
  }

  let awsRegion = '';
  try {
    awsRegion = (await ec2.config.region()) || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
  } catch (error) {
    core.warning(`Failed to retrieve AWS region for user-data tagging: ${error ? error.message : error}`);
  }

  let isReusable = config.input.reuseRunner === 'true';
  const tagsFilters = [];
  const generalLabels = [];

  for (const tag of config.tagSpecifications) {
    tagsFilters.push({ Name: `tag:${tag.Key}`, Values: [tag.Value] });
    generalLabels.push(tag.Value);
  }

  const userData = buildUserDataScript(githubToken, config.input.runnerCount, generalLabels.join(','), runnerVersion, awsCreds, awsRegion);

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
    MetadataOptions: { HttpTokens: 'required' },
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

  if (config.input.reuseRunner === 'true') {
    const describeParams = {
      Filters: [
        ...tagsFilters,
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
        { Name: 'instance-type', Values: [config.input.ec2InstanceType] },
        { Name: 'image-id', Values: [config.input.ec2ImageId] },
      ],
    };

    core.info(`Checking for resumable instances with filter ${JSON.stringify(describeParams)}`);

    try {
      const result = await ec2.describeInstances(describeParams);
      const stoppedInstances = [];
      let totalInstancesCount = 0;

      if (result && result.Reservations) {
        for (const reservation of result.Reservations) {
          if (reservation.Instances) {
            for (const instance of reservation.Instances) {
              totalInstancesCount++;
              if (instance.State && instance.State.Name === 'stopped') {
                stoppedInstances.push(instance.InstanceId);
              }
            }
          }
        }
      }

      if (stoppedInstances.length > 0) {
        // Shuffle the remaining stopped instances to distribute load and reduce collisions
        stoppedInstances.sort(() => Math.random() - 0.5);

        for (const id of stoppedInstances) {
          try {
            try {
              await ec2.modifyInstanceAttribute({
                InstanceId: id,
                UserData: { Value: Buffer.from(userData) },
              });
            } catch (attrError) {
              core.warning(`Failed to modify instance UserData attribute for ${id}: ${attrError ? attrError.message : attrError}`);
            }
            const startResult = await ec2.startInstances({ InstanceIds: [id] });
            const previousState = startResult.StartingInstances[0].PreviousState.Name;

            // AWS guarantees the instance state transitions atomically. If it was already
            // pending or running, another workflow won the race condition.
            if (previousState === 'stopped') {
              core.info(`AWS EC2 instance ${id} is starting`);
              try {
                await ec2.deleteTags({
                  Resources: [id],
                  Tags: [{ Key: TAG_RUNNER_STATUS }],
                });
              } catch (tagClearError) {
                // Ignore if tag doesn't exist
              }
              try {
                await ec2.createTags({
                  Resources: [id],
                  Tags: [{ Key: TAG_REUSE_RUNNER, Value: 'true' }],
                });
              } catch (tagError) {
                core.warning(`Failed to tag instance ${id} with ${TAG_REUSE_RUNNER}=true: ${tagError ? tagError.message : tagError}`);
              }
              return getRunnersInfo(id);
            } else {
              core.info(`AWS EC2 instance ${id} was already starting (race condition lost), trying another...`);
            }
          } catch (error) {
            const errName = (error && error.name) || '';
            core.warning(`AWS EC2 instance ${id} starting error`);
            core.warning(`${errName}: ${error ? error.message : error}`);
            if (errName.includes('InsufficientInstanceCapacity')) {
              delete runParams.InstanceMarketOptions;
              runParams.InstanceInitiatedShutdownBehavior = 'terminate';
              isReusable = false;
            } else if (errName.includes('IncorrectSpotRequestState')) {
              runParams.InstanceInitiatedShutdownBehavior = 'terminate';
              runParams.InstanceMarketOptions = {
                MarketType: 'spot',
                SpotOptions: {
                  InstanceInterruptionBehavior: 'terminate',
                  SpotInstanceType: 'one-time',
                },
              };
              isReusable = false;
            }
          }
        }
      }

      // If we couldn't reuse any runner, we are going to fall through and create a new one.
      // We check if we have already reached the maximum allowed resumable instances.
      if (config.input.maxReusableInstances > 0 && totalInstancesCount >= config.input.maxReusableInstances) {
        core.info(`Total instances count (${totalInstancesCount}) reached the limit (${config.input.maxReusableInstances}).`);
        core.info('The new runner will be launched as a standard non-resumable instance to prevent EBS leaks.');
        runParams.InstanceInitiatedShutdownBehavior = 'terminate';
        if (runParams.InstanceMarketOptions && runParams.InstanceMarketOptions.SpotOptions) {
          runParams.InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior = 'terminate';
          runParams.InstanceMarketOptions.SpotOptions.SpotInstanceType = 'one-time';
        }
        isReusable = false;
      }
    } catch (error) {
      core.error('Failed to check for resumable instances');
      throw error;
    }
  }

  let lastError = null;
  for (let i = 0; i < 2; i++) {
    try {
      const instanceTags = [...config.tagSpecifications, { Key: TAG_REUSE_RUNNER, Value: isReusable ? 'true' : 'false' }];
      runParams.TagSpecifications = [
        { ResourceType: 'instance', Tags: instanceTags },
        { ResourceType: 'volume', Tags: config.tagSpecifications },
      ];

      const result = await ec2.runInstances(runParams);
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is starting`);
      return getRunnersInfo(ec2InstanceId);
    } catch (error) {
      const errName = (error && error.name) || '';
      core.warning('AWS EC2 instance starting error');
      core.warning(`${errName}: ${error ? error.message : error}`);
      lastError = error;
      if (errName.includes('InsufficientInstanceCapacity')) {
        delete runParams.InstanceMarketOptions;
        runParams.InstanceInitiatedShutdownBehavior = 'terminate';
        isReusable = false;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function terminateEc2Instance(specifiedInstanceId, forceTerminate = false) {
  const ec2 = new AWS.EC2();
  const instanceId = specifiedInstanceId || config.input.ec2InstanceId;

  if (!instanceId) {
    core.warning('No EC2 instance ID provided for termination');
    return;
  }

  const params = {
    InstanceIds: [instanceId],
  };

  let shouldReuse = config.input.reuseRunner === 'true';

  if (!forceTerminate) {
    try {
      const describeResult = await ec2.describeInstances({ InstanceIds: [instanceId] });
      if (describeResult && describeResult.Reservations && describeResult.Reservations[0] && describeResult.Reservations[0].Instances) {
        const instance = describeResult.Reservations[0].Instances[0];
        const tags = instance.Tags || [];
        const reuseTag = tags.find((t) => t.Key === TAG_REUSE_RUNNER);
        if (reuseTag) {
          shouldReuse = reuseTag.Value === 'true';
          core.info(`Found ${TAG_REUSE_RUNNER} tag on instance ${instanceId}: ${reuseTag.Value}`);
        } else {
          core.info(`No ${TAG_REUSE_RUNNER} tag found on instance ${instanceId}. Falling back to input reuseRunner: ${config.input.reuseRunner}`);
        }
      }
    } catch (describeError) {
      core.warning(
        `Failed to describe instance ${instanceId} to check ${TAG_REUSE_RUNNER} tag: ${describeError ? describeError.message : describeError}. Falling back to input reuseRunner: ${config.input.reuseRunner}`
      );
    }
  } else {
    core.info(`Force terminate flag set for instance ${instanceId}. Skipping reuse check.`);
    shouldReuse = false;
  }

  try {
    if (shouldReuse) {
      try {
        await ec2.deleteTags({
          Resources: [instanceId],
          Tags: [{ Key: TAG_RUNNER_STATUS }],
        });
        core.info(`AWS EC2 instance ${instanceId} ${TAG_RUNNER_STATUS} tag cleared`);
      } catch (tagError) {
        core.warning(`Failed to clear ${TAG_RUNNER_STATUS} tag on instance ${instanceId}: ${tagError ? tagError.message : tagError}`);
      }
      await ec2.stopInstances(params);
      core.info(`AWS EC2 instance ${instanceId} is stopped`);
      return;
    }
  } catch (error) {
    const errName = (error && error.name) || '';
    core.warning(`AWS EC2 instance ${instanceId} termination error`);
    core.warning(`${errName}: ${error ? error.message : error}`);
    if (!errName.includes('UnsupportedOperation')) {
      throw error;
    }
  }

  const spotRequestQuery = {
    Filters: [{ Name: 'instance-id', Value: [instanceId] }],
  };
  try {
    const result = await ec2.describeSpotInstanceRequests(spotRequestQuery);
    if (result && Array.isArray(result.SpotInstanceRequests) && result.SpotInstanceRequests.length > 0) {
      const spotCancelRequest = {
        SpotInstanceRequestIds: result.SpotInstanceRequests.map((x) => x.SpotInstanceRequestId),
      };

      await ec2.cancelSpotInstanceRequests(spotCancelRequest);
      core.info(`AWS EC2 spot instance request(s) canceled for ${instanceId}`);
    }
  } catch (error) {
    core.warning(`Spot instance request cancel error: ${error ? error.message : error}`);
  }

  await ec2.terminateInstances(params);
  core.info(`AWS EC2 instance ${instanceId} is terminated`);
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

async function waitForRunnerReady(runnersInfo) {
  const ec2 = new AWS.EC2();
  const ec2InstanceId = runnersInfo.instanceId;
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 5;
  const maxAttempts = Math.floor((timeoutMinutes * 60) / retryIntervalSeconds);

  core.info(`Checking AWS EC2 instance ${ec2InstanceId} for self-hosted runner readiness every ${retryIntervalSeconds}s...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const describeResult = await ec2.describeInstances({
        InstanceIds: [ec2InstanceId],
      });

      if (describeResult && describeResult.Reservations && describeResult.Reservations[0] && describeResult.Reservations[0].Instances) {
        const instance = describeResult.Reservations[0].Instances[0];
        const stateName = instance.State ? instance.State.Name : '';

        if (stateName === 'terminated' || stateName === 'stopped') {
          throw new Error(`AWS EC2 instance ${ec2InstanceId} was unexpectedly ${stateName}`);
        }

        const tags = instance.Tags || [];
        const runnerStatusTag = tags.find((t) => t.Key === TAG_RUNNER_STATUS);
        if (runnerStatusTag && runnerStatusTag.Value === RUNNER_STATUS_ONLINE) {
          core.info(`AWS EC2 self-hosted runner on instance ${ec2InstanceId} is registered and ready to use (via EC2 tag)`);
          return;
        }
      }

      // 2. Fallback: Check GitHub API only after 3 minutes (attempt > 36) to prevent rate limits
      if (attempt > 36 && attempt % 3 === 0) {
        try {
          const ghRunners = await gh.getRunners(ec2InstanceId);
          if (ghRunners) {
            const readyRunners = ghRunners
              .filter((r) => runnersInfo.runners.indexOf(r.name) >= 0)
              .filter((r) => r.status === 'online');
            if (readyRunners.length >= parseInt(config.input.runnerCount || '1', 10)) {
              core.info(`GitHub self-hosted runner on instance ${ec2InstanceId} is registered and ready to use (via GitHub API)`);
              try {
                await ec2.createTags({
                  Resources: [ec2InstanceId],
                  Tags: [{ Key: TAG_RUNNER_STATUS, Value: RUNNER_STATUS_ONLINE }],
                });
              } catch (e) {
                core.warning(`Failed to create ${TAG_RUNNER_STATUS} tag for instance ${ec2InstanceId}: ${e ? e.message : e}`);
              }
              return;
            }
          }
        } catch (ghError) {
          core.warning(`GitHub API readiness check error for instance ${ec2InstanceId}: ${ghError ? ghError.message : ghError}`);
        }
      }

    } catch (error) {
      if (error.message && error.message.includes('unexpectedly')) {
        throw error;
      }
      core.warning(`Checking status for AWS EC2 instance ${ec2InstanceId}: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryIntervalSeconds * 1000));
  }

  throw new Error(`A timeout of ${timeoutMinutes} minutes is exceeded waiting for runner on AWS EC2 instance ${ec2InstanceId}.`);
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
  waitForRunnerReady,
};
