require('dotenv').config()

const _ = require('lodash')
const { Octokit } = require('@octokit/core')
const axios = require('axios')
const dayjs = require('dayjs')
const JSON5 = require('json5')
const Papa = require('papaparse')
const Qs = require('qs')

dayjs.extend(require('dayjs/plugin/utc'))

const getenv = (key, defaultval) => _.get(process, ['env', key], defaultval)
const getNow = () => dayjs().utcOffset(8)
const httpBuildQuery = (obj, overrides = {}) => Qs.stringify(obj, { arrayFormat: 'brackets', ...overrides })

const octokit = new Octokit({ auth: getenv('GITHUB_TOKEN') })
const GIST_CONTEXT = getenv('GIST_CONTEXT')

const errToPlainObj = (() => {
  const ERROR_KEYS = [
    'address',
    'data',
    'dest',
    'errno',
    'info',
    'message',
    'name',
    'originalError.response.data',
    'originalError.response.headers',
    'originalError.response.status',
    'path',
    'port',
    'reason',
    'response.data',
    'response.headers',
    'response.status',
    'stack',
    'status',
    'statusCode',
    'statusMessage',
    'syscall',
  ]
  return err => _.pick(err, ERROR_KEYS)
})()

const log = (() => {
  const LOG_SEVERITY = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']
  return (...args) => {
    let severity = 'DEFAULT'
    if (args.length > 1 && _.includes(LOG_SEVERITY, _.toUpper(args[0]))) severity = _.toUpper(args.shift())
    _.each(args, arg => {
      if (_.isString(arg)) arg = { message: arg }
      if (arg instanceof Error) arg = errToPlainObj(arg)
      console.log(JSON.stringify({ severity, ...arg }))
    })
  }
})()

async function ctxsRead () {
  try {
    const res = await octokit.request('GET /gists/{gist_id}', { gist_id: GIST_CONTEXT })
    return JSON5.parse(res?.data?.files?.['ctxs.json5']?.content)
  } catch (err) {
    return []
  }
}

async function ctxsWrite (ctxs) {
  await octokit.request('PATCH /gists/{gist_id}', {
    gist_id: GIST_CONTEXT,
    files: {
      'ctxs.json5': {
        content: JSON5.stringify(ctxs, null, 2),
      },
    },
  })
}

async function getCsv (url, cachetime = 3e4) {
  const csv = _.trim(_.get(await axios.get(url, {
    params: { cachebust: _.floor(Date.now() / cachetime) },
  }), 'data'))
  return _.get(Papa.parse(csv, {
    encoding: 'utf8',
    header: true,
  }), 'data', [])
}

async function sendNotify (token, body) {
  try {
    if (!token) throw new Error('token is required')
    await axios.post('https://notify-api.line.me/api/notify', httpBuildQuery(body), {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    err.message = err.response?.data?.message || err.message
    err.status = err.response?.status || 500
    throw err
  }
}

async function handleNotifyCtx (ctx) {
  try {
    // 避免重複通知
    const today = getNow().format('YYYY-MM-DD')
    if (ctx.today === today) {
      console.log('今天已經執行過了')
      return
    }
    ctx.today = today

    // 讀取 csv 檔案
    const conf = _.fromPairs(_.map(await getCsv(ctx.csv), row => [_.toSafeInteger(row.date), _.trim(row.message)]))
    const message = conf?.[getNow().add(1, 'day').date()]
    if (_.isString(message) && message.length > 0) {
      await sendNotify(ctx.token, { message })
      console.log(`成功傳送 LINE Notify，訊息長度 ${message.length}。`)
    }
  } catch (err) {
    log(err)
  }
}

;(async function main () {
  try {
    if (!GIST_CONTEXT) throw new Error('GIST_CONTEXT is required')
    const ctxs = await ctxsRead() // 讀取設定檔
    console.log(`成功讀到 ${ctxs.length} 組設定。`)

    for (const [ctxIdx, ctx] of _.toPairs(ctxs)) {
      console.log(`\n---\n開始執行第 ${_.toSafeInteger(ctxIdx) + 1} 組設定:`)
      await handleNotifyCtx(ctx)
    }

    await ctxsWrite(ctxs) // 寫回設定檔
  } catch (err) {
    console.log('\n---\n發生重大錯誤:')
    log(err)
    process.exit(1)
  }
})()
