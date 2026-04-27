#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const repoRoot = path.resolve(__dirname, '..')

require.extensions['.ts'] = function registerTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true
    },
    fileName: filename
  })
  module._compile(output.outputText, filename)
}

function parseArgs(argv) {
  const args = {
    cases: 'evaluation/retrieval/baseline.local.jsonl',
    out: '.tmp/retrieval-eval-report.json',
    mode: 'hybrid',
    limit: 20,
    prepareVectorIndex: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--cases') args.cases = argv[++index]
    else if (item === '--out') args.out = argv[++index]
    else if (item === '--mode') args.mode = argv[++index]
    else if (item === '--limit') args.limit = Number(argv[++index] || 20)
    else if (item === '--prepare-vector-index') args.prepareVectorIndex = true
    else if (item === '--help' || item === '-h') args.help = true
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-retrieval-evaluator.cjs [options]

Options:
  --cases <path>                JSONL evaluation set. Default: evaluation/retrieval/baseline.local.jsonl
  --out <path>                  Report output path. Default: .tmp/retrieval-eval-report.json
  --mode <keyword|vector|hybrid> Retrieval baseline mode. Default: hybrid
  --limit <number>              Top K per retrieval path. Default: 20
  --prepare-vector-index        Build/refresh vector index before vector or hybrid evaluation
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const casesPath = path.resolve(repoRoot, args.cases)
  const outPath = path.resolve(repoRoot, args.out)
  const {
    loadRetrievalEvalCases,
    runRetrievalEvaluation
  } = require(path.join(repoRoot, 'electron/services/retrieval/retrievalEvaluator.ts'))

  const cases = loadRetrievalEvalCases(casesPath)
  const report = await runRetrievalEvaluation({
    cases,
    mode: args.mode,
    limit: args.limit,
    prepareVectorIndex: args.prepareVectorIndex,
    onCaseComplete: (result) => {
      const mark = result.error ? 'ERROR' : (result.recallAt10 ? 'HIT@10' : 'MISS')
      console.log(`[${mark}] ${result.id} rank=${result.firstMatchRank || '-'} latency=${result.latencyMs}ms`)
    }
  })

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`Report written: ${path.relative(repoRoot, outPath)}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
