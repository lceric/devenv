const http = require('http')
const path = require('path')
const fs = require('fs')
const connect = require('connect')
const chokidar = require('chokidar')
const httpProxy = require('http-proxy')
const parseUrl = require('parseurl')
const bodyParser = require('body-parser')
const send = require('send')
const es = require('event-stream')
const WebSocket = require('ws')
const { PassThrough, Stream, Readable } = require('stream')

const projectRoot = process.cwd()
const defaultWorkspace = path.join(projectRoot,`./src`)

const opts = {
  host: '0.0.0.0',
  port: '3002',
  proxy: {
    '/api': {
      target: 'http://xhx.xstable.kaikela.cn',
      ws: true,
      changeOrigin: true,
      pathRewrite: {
        '^/api': '',
      },
    },
  },
  before: null,
  workspace: defaultWorkspace,
  root: projectRoot,
  send: {},
  wsInjectScript: path.join(__dirname, './extra.inject.js'),
}
console.log(projectRoot)
// 读取配置文件
try {
  let config = require(path.join(projectRoot,`./lds.config.js`))
  let { workspace, ...restConfig } = config
  let extra = {
    workspace: workspace ? path.join(projectRoot, workspace) : defaultWorkspace
  }
  // TODO deep merge
  Object.assign(opts, restConfig, extra)
} catch (error) {
  console.log('没有lds.config.js配置文件')  
}

const protocol = 'http'
const { port, host, proxy } = opts
const openHost = host === '0.0.0.0' ? 'localhost' : host

const app = connect()
const onDirectory = createNotFoundDirectoryListener()

const INJECT_TAG = '</body>'
const CUSTOME_INJECT_POSITION = `//////`
const INJECT_SCRIPT = fs.readFileSync(path.join(__dirname, './inject.html'), { encoding: 'utf-8' })

const server = http.createServer(app)
const wsIns = new WebSocket.Server({ server })
const watcher = chokidar.watch(opts.workspace, {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
})

let openURL = ''
let clients = []
let customInjectScript = ''
let handleInject = function () {}

// 读取自定义inject片段
try {
  customInjectScript = fs.readFileSync(
    opts.wsInjectScript,
    { encoding: 'utf-8' }
  )
} catch (error) {
  console.log('没有找到自定义的inject文件')
}

app.use(bodyParser.urlencoded({ extended: false }))

app.use(function (req, res, next) {
  var originalUrl = parseUrl.original(req)
  var reqPath = parseUrl(req).pathname
  let proxyServer = null
  
  opts.before instanceof Function && opts.before.call(this, req, res, next)

  if (proxy) {
    // 处理代理
    for (const p in proxy) {
      if (reqPath.slice(0, p.length) == p) {
        proxyServer = httpProxy.createProxyServer({})

        let proxyItemOpts = JSON.parse(JSON.stringify(proxy[p]))
        let { target, pathRewrite } = proxyItemOpts

        // 处理pathRewrite
        let resultReqPath = reqPath
        for (let pr in pathRewrite) {
          resultReqPath = resultReqPath.replace(new RegExp(pr), pathRewrite[pr])
        }
        delete proxyItemOpts.pathRewrite

        req.url = resultReqPath + originalUrl.search
        target && proxyServer.web(req, res, proxyItemOpts)
        return
      }
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // method not allowed
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.setHeader('Content-Length', '0')
    res.end()
    return
  }

  // make sure redirect occurs at mount
  if (reqPath === '/' && originalUrl.pathname.substr(-1) !== '/') {
    reqPath = ''
  }
  
  // 如果是/demo/src/的时候，会指向到demo/src/index.html，这种情况需要注入inject片段
  let maybeNeedInject = reqPath == '' || reqPath.indexOf('.html') > -1 || originalUrl.pathname.substr(-1) === '/'
  let sendOpts = Object.assign(
    {
      root: opts.root,
    },
    opts.send
  )

  if (maybeNeedInject) {
    handleInject = function (stream) {
      
      let len = INJECT_SCRIPT.length
      // 判断是否是html, 决定是否注入
      let ctstr = res.getHeader('content-type')
      if (ctstr.indexOf('html') < 0) return

      if (customInjectScript.length) {
        len += customInjectScript.length
      }
      len += res.getHeader('Content-Length')
      res.setHeader('Content-Length', len)

      let originalPipe = stream.pipe
      stream.pipe = function (resq) {
        // TODO 此处优化掉es模块
        let tmpStream = originalPipe.call(
          stream,
          es.replace(new RegExp(INJECT_TAG, 'i'), INJECT_SCRIPT + INJECT_TAG)
        )
        // ws message, inject custom scripts
        let tmpPipe = tmpStream.pipe
        tmpPipe
          .call(
            tmpStream,
            es.replace(
              new RegExp(CUSTOME_INJECT_POSITION, 'i'),
              customInjectScript + CUSTOME_INJECT_POSITION
            )
          )
          .pipe(resq)
      }
    }
  }

  // create send stream
  let sendStream = send(req, reqPath, sendOpts)
  // add directory handler
  sendStream.on('directory', onDirectory)
  // pipe
  maybeNeedInject && sendStream.on('stream', handleInject)
  sendStream.pipe(res)
})

wsIns.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
    console.log('received: %s', message)
  })

  clients.push(ws)

  ws.on('close', function (param) {
    clients = clients.filter((itm) => {
      return ws != itm
    })
  })
})

watcher.on('change', (path) => {
  clients.forEach((ws) => {
    ws.send(generateWatchMessage('reload', path))
  })
})

server.addListener('listening', function () {
  const address = server.address()
  // let serveHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address
  openURL = protocol + '://' + openHost + ':' + address.port

  console.log(openURL)
})

server.listen(port)

function createNotFoundDirectoryListener() {
  return function notFound() {
    this.error(404)
  }
}

/**
 * generate send message
 * @param {String} sign ws send type, reload...
 * @param {Object} data send data
 */
function generateMessage(sign, data) {
  return JSON.stringify({
    sign,
    data,
  })
}

/**
 * watch file change, generate send message
 * @param {String} sign type
 * @param {String} path file path
 */
function generateWatchMessage(sign, path) {
  return generateMessage(sign, { path, host: openURL })
}
