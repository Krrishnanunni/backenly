// Scenarios for the rehearsal launcher's AWS conversation. Every value is a
// fixture: 111122223333 is the account id AWS documentation uses, and no ARN
// here names a real resource.

const ACCOUNT = '111122223333'
const TASK_ARN = `arn:aws:ecs:ap-south-1:${ACCOUNT}:task/backenly-staging/0123456789abcdef0`
const TASK_DEF_ARN = `arn:aws:ecs:ap-south-1:${ACCOUNT}:task-definition/backenly-staging-maintenance-rehearsal:7`
const RESULT_BEGIN = '---REHEARSAL-RESULT-BEGIN---'
const RESULT_END = '---REHEARSAL-RESULT-END---'

const secret = (name, env = 'staging') => ({
  name,
  valueFrom: `arn:aws:secretsmanager:ap-south-1:${ACCOUNT}:secret:backenly-${env}/${name.toLowerCase()}-Ab12Cd`,
})

function resultEvents(result) {
  const body = JSON.stringify(
    {
      result,
      schema: '_rehearsal_1700000000000',
      at: '2026-09-15T00:00:00.000Z',
      tests: { add_column_lock: 'PASS', reconciliation: result },
      detail: { add_column_lock: 'added in 3ms, present=true', reconciliation: 'fixture' },
    },
    null,
    2,
  )
  return ['[rehearsal] schema _rehearsal_1700000000000', RESULT_BEGIN, ...body.split('\n'), RESULT_END].map(
    (message, i) => ({ timestamp: 1700000000000 + i, message }),
  )
}

function base() {
  return {
    'sts get-caller-identity': { Account: ACCOUNT },
    'ecs describe-services': {
      services: [
        {
          networkConfiguration: {
            awsvpcConfiguration: { subnets: ['subnet-0aaa', 'subnet-0bbb'], securityGroups: ['sg-0ccc'], assignPublicIp: 'ENABLED' },
          },
        },
      ],
    },
    'ecs describe-task-definition': {
      taskDefinition: {
        executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/backenly-staging-execution`,
        containerDefinitions: [
          {
            image: `${ACCOUNT}.dkr.ecr.ap-south-1.amazonaws.com/backenly-runtime:fixture`,
            secrets: [secret('DATABASE_URL'), secret('JWT_SECRET'), secret('DIRECT_URL'), secret('MASTER_ENCRYPTION_KEY')],
          },
        ],
      },
    },
    'ecs register-task-definition': { taskDefinition: { taskDefinitionArn: TASK_DEF_ARN } },
    'ecs run-task': { tasks: [{ taskArn: TASK_ARN }], failures: [] },
    'ecs describe-tasks': {
      tasks: [{ stoppedReason: 'Essential container in task exited', containers: [{ exitCode: 0 }] }],
    },
    'logs get-log-events': { events: resultEvents('PASS'), nextForwardToken: 'f/end' },
    'ecs deregister-task-definition': { taskDefinition: { taskDefinitionArn: TASK_DEF_ARN } },
  }
}

const with_ = patch => ({ ...base(), ...patch })

module.exports = [
  { name: 'refuses without an expected account', account: undefined, aws: base() },
  { name: 'refuses on an account mismatch', account: ACCOUNT, aws: with_({ 'sts get-caller-identity': { Account: '444455556666' } }) },
  { name: 'refuses when the service is missing', account: ACCOUNT, aws: with_({ 'ecs describe-services': { services: [] } }) },
  { name: 'refuses without awsvpc configuration', account: ACCOUNT, aws: with_({ 'ecs describe-services': { services: [{}] } }) },
  { name: 'refuses when the task definition is unreadable', account: ACCOUNT, aws: with_({ 'ecs describe-task-definition': {} }) },
  {
    name: 'refuses without a DATABASE_URL secret',
    account: ACCOUNT,
    aws: with_({
      'ecs describe-task-definition': {
        taskDefinition: { executionRoleArn: 'role', containerDefinitions: [{ image: 'img', secrets: [secret('JWT_SECRET')] }] },
      },
    }),
  },
  {
    name: 'refuses a production secret ARN',
    account: ACCOUNT,
    aws: with_({
      'ecs describe-task-definition': {
        taskDefinition: { executionRoleArn: 'role', containerDefinitions: [{ image: 'img', secrets: [secret('DATABASE_URL', 'production')] }] },
      },
    }),
  },
  {
    name: 'refuses a secret that does not name staging',
    account: ACCOUNT,
    aws: with_({
      'ecs describe-task-definition': {
        taskDefinition: { executionRoleArn: 'role', containerDefinitions: [{ image: 'img', secrets: [secret('DATABASE_URL', 'shared')] }] },
      },
    }),
  },
  { name: 'refuses a bundle older than its source', account: ACCOUNT, staleBundle: true, aws: base() },
  { name: 'run-task failures', account: ACCOUNT, aws: with_({ 'ecs run-task': { tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] } }) },
  { name: 'PASS result', account: ACCOUNT, aws: base() },
  { name: 'FAIL result', account: ACCOUNT, aws: with_({ 'logs get-log-events': { events: resultEvents('FAIL'), nextForwardToken: 'f/end' } }) },
  {
    name: 'no machine-readable result',
    account: ACCOUNT,
    aws: with_({ 'logs get-log-events': { events: [{ timestamp: 1, message: 'crashed before result' }], nextForwardToken: 'f/end' } }),
  },
  { name: 'log read throws', account: ACCOUNT, aws: with_({ 'logs get-log-events': { __throw: 'ResourceNotFoundException: stream' } }) },
  { name: 'deregister throws', account: ACCOUNT, aws: with_({ 'ecs deregister-task-definition': { __throw: 'AccessDenied' } }) },
]
