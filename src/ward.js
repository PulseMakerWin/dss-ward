require('dotenv').config();
const { ArgumentParser } = require('argparse');
const Web3 = require('web3');
const settings = require('../settings.js');
const fs = require('fs');
const fetch = require('node-fetch');
const treeify = require('treeify');
const Diff = require('diff');
const chalk = require('chalk');
const { createHash } = require('crypto');

const allLogs = [];
const scannedAddresses = [];

const getJson = path => {
  return JSON.parse(fs.readFileSync(path));
}

const getEnv = () => {
  const vars = [ 'ETH_RPC_URL' ];
  const env = {};
  for (const v of vars) {
    if (!process.env[v]) {
      console.log(`please specify a ${v} env var`);
      process.exit();
    }
    env[v] = process.env[v];
  }
  return env;
}

const getSig = (web3, funcWithParams) => {
  const hash = web3.utils.sha3(funcWithParams);
  const sig = hash.substring(0, 10);
  const paddedSig = `${ sig }${ '0'.repeat(56) }`
  return paddedSig;
}

const isAddress = string => {
  return Boolean(string.match('^0x[0-9a-fA-F]{40}$'))
}

const getAddresses = (web3, log) => {
  const addresses = [];
  const { topics, data } = log;
  for (const topic of topics) {
    if (topic.match(/^0x0{24}/)) {
      const address = `0x${ topic.substring(26, 66) }`;
      const checksumAddress = web3.utils.toChecksumAddress(address);
      addresses.push(checksumAddress);
    }
  }
  const chunks = data.substring(2).match(/.{64}/g);
  if (chunks) {
    for (const chunk of chunks) {
      if (chunk.match(/^0{24}/)) {
        const address = `0x${ chunk.substring(24, 64) }`;
        const checksumAddress = web3.utils.toChecksumAddress(address);
        addresses.push(checksumAddress);
      }
    }
  }
  return addresses;
}

const getChainLog = async (args, web3) => {
  if (cached(args).includes('chainlog')) {
    return JSON.parse(fs.readFileSync('cached/chainLog.json', 'utf8'));
  }
  const chainLog = {};
  const abi = getJson('./lib/dss-chain-log/out/ChainLog.abi');
  const contract = new web3.eth.Contract(abi, settings.chainLogAddress);
  const count = await contract.methods.count().call();
  for (let i = 0; i < count; i ++) {
    const progress = Math.floor(100 * i / count);
    process.stdout.write(`downloading the chainlog... ${ progress }%\r`);
    const result = await contract.methods.get(i).call();
    const address = result['1'];
    const nameHex = result['0'];
    const name = web3.utils.hexToUtf8(nameHex);
    chainLog[address] = name;
  }
  console.log();
  fs.writeFileSync('cached/chainLog.json', JSON.stringify(chainLog));
  return chainLog;
}

const getKey = (object, value) => {
  return Object.keys(object).find(key => object[key] === value);
}

const getWho = (chainLog, address) => {
  return chainLog[address] || address;
}

const getTopics = web3 => {
  const logNoteRely = getSig(web3, 'rely(address)');
  const logNoteKiss = getSig(web3, 'kiss(address)');
  const logNoteKisses = getSig(web3, 'kiss(address[])');
  const eventRely = web3.utils.sha3('Rely(address)');
  const eventKiss = web3.utils.sha3('Kiss(address)');
  const topics = [[
    logNoteRely,
    logNoteKiss,
    logNoteKisses,
    eventRely,
    eventKiss
  ]];
  return topics;
}

const MAX_RETRIES = 3;
const BATCH_SIZE_LIMIT = 4096;  // Lower the batch size to prevent overflow

// Fetch past logs with retry logic
const getPastLogsWithRetry = async (web3, options) => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await web3.eth.getPastLogs(options);
    } catch (err) {
      console.error(`Attempt ${attempt} failed. Retrying...`);
      if (attempt === MAX_RETRIES) {
        console.error(`Error after ${MAX_RETRIES} attempts:`, err);
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const PROGRESS_FILE = 'progress.json';

let currentProgress = { fromBlock: null }; // Track current progress in a variable

const saveProgress = (progress) => {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 4));
};

const loadProgress = () => {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  }
  return null;
};

// Listen for termination signals to save progress
process.on('SIGINT', () => {
  console.log('\nGracefully shutting down...');
  if (currentProgress.fromBlock !== null) {
    saveProgress(currentProgress);
  }
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('\nGracefully shutting down...');
  if (currentProgress.fromBlock !== null) {
    saveProgress(currentProgress);
  }
  process.exit();
});

// Modified getLogs function with batch size control
const getLogs = async (args, web3, chainLog, addresses) => {
  const digest = createHash('sha256').update(addresses.join()).digest('hex');
  const cacheFilePath = `cached/logs-${digest}.json`;

  // Check if logs are already cached
  if (fs.existsSync(cacheFilePath)) {
    console.log(`Loading logs from cache: ${cacheFilePath}`);
    return JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
  }

  const logs = [];
  const topics = getTopics(web3);
  const end = await web3.eth.getBlockNumber();
  const { mcdDeployment } = settings;
  let fromBlock = mcdDeployment;
  const totalBlocks = end - fromBlock;

  // Load progress if available
  const savedProgress = loadProgress();
  if (savedProgress && savedProgress.fromBlock) {
    fromBlock = savedProgress.fromBlock;
  }

  while (fromBlock < end) {
    const toBlock = Math.min(fromBlock + BATCH_SIZE_LIMIT, end);
    const progress = ((fromBlock - mcdDeployment) / totalBlocks * 100).toFixed(2);
    process.stdout.write(`Scanning logs... ${progress}%\r`);

    try {
      const batch = await getPastLogsWithRetry(web3, {
        fromBlock,
        toBlock,
        address: addresses,
        topics,
      });

      for (const log of batch) {
        const block = await web3.eth.getBlock(log.blockNumber);
        log.timestamp = new Date(block.timestamp * 1000).toISOString();
      }
      logs.push(...batch);

      // Update current progress and save it
      currentProgress.fromBlock = toBlock + 1;
      saveProgress(currentProgress);
      fs.writeFileSync(cacheFilePath, JSON.stringify(logs, null, 4));
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
    fromBlock = toBlock + 1;
  }

  process.stdout.write('\rScanning logs... 100%\n'); // Clear the line after completion

  // Remove progress file after completion
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
  }

  return logs;
};

const getReliesAndKisses = async (args, web3, chainLog, address) => {
  const who = getWho(chainLog, address);
  const reliesAndKisses = [];
  let logs;
  if (scannedAddresses.includes(address)) {
    logs = allLogs.filter(log => log.address === address);
    console.log(`getting logNote and event relies and kisses for ${who}... found ${logs.length} cached relies and/or kisses`);
  } else {
    logs = await getLogs(args, web3, chainLog, [address]);
    allLogs.push(...logs);
    scannedAddresses.push(address);
  }
  for (const log of logs) {
    const addresses = getAddresses(web3, log);
    reliesAndKisses.push(...addresses);
  }
  const uniqueReliesAndKisses = Array.from(new Set(reliesAndKisses));
  return uniqueReliesAndKisses;
}

const getOwner = async (web3, chainLog, address) => {
  const who = getWho(chainLog, address);
  const abi = getJson('./lib/ds-pause/out/DSPause.abi');
  const contract = new web3.eth.Contract(abi, address);
  process.stdout.write(`getting owner for ${who}... `);
  try {
    const owner = await contract.methods.owner().call();
    console.log(getWho(chainLog, owner));
    if (Number(owner) != 0) {
      return owner;
    }
  } catch (err) {
    console.log('no owner');
  }
  return null;
}

const getAuthority = async (web3, chainLog, address) => {
  const who = getWho(chainLog, address);
  const abi = getJson('./lib/ds-pause/out/DSPause.abi');
  const contract = new web3.eth.Contract(abi, address);
  process.stdout.write(`getting authority for ${who}... `);
  try {
    const authority = await contract.methods.authority().call();
    console.log(getWho(chainLog, authority));
    if (Number(authority) != 0) {
      return authority;
    }
  } catch (err) {
    console.log('no authority');
  }
  return null;
}

const getTxs = async (env, address, internal) => {
  console.log(`Starting ${internal ? 'internal' : 'external'} transaction scan for ${address}`);
  const web3 = new Web3(env.ETH_RPC_URL);
  const latestBlock = await web3.eth.getBlockNumber();
  const START_BLOCK = 16492700;
  let currentBlock = START_BLOCK;
  const allTxs = [];

  while (currentBlock < latestBlock) {
    const toBlock = Math.min(currentBlock + BATCH_SIZE_LIMIT, latestBlock);
    const progress = ((currentBlock - START_BLOCK) / (latestBlock - START_BLOCK) * 100).toFixed(2);
    process.stdout.write(`\rScanning transactions... ${progress}%`);

    try {
      const batch = await getPastLogsWithRetry(web3, {
        fromBlock: currentBlock,
        toBlock: toBlock,
        address: address,
      });

      for (const tx of batch) {
        const block = await web3.eth.getBlock(tx.blockNumber);
        allTxs.push({
          from: tx.address,
          to: tx.address,
          type: internal ? 'internal' : 'external',
          timestamp: new Date(block.timestamp * 1000).toISOString(),
        });
      }
    } catch (err) {
      console.warn(`Error processing batch ${currentBlock}-${toBlock}:`, err);
    }
    currentBlock = toBlock + 1;
  }

  process.stdout.write('Scanning transactions... 100%');
  console.log(`Found ${allTxs.length} transactions`);
  return allTxs;
};

const getDeployers = async (env, web3, chainLog, address) => {
  const who = getWho(chainLog, address);
  console.log(`\nStarting deployer search for ${who} (${address})`);
  try {
    console.log('Getting regular transactions...');
    const regularTxs = await getTxs(env, address, false);
    
    console.log('Getting internal transactions...');
    const internalTxs = await getTxs(env, address, true);
    
    const txs = regularTxs.concat(internalTxs);
    console.log(`Total transactions found: ${txs.length}`);
    
    if (txs.length === 0) {
      console.log('No deployment transactions found');
      return [];
    }

    const deployTxs = txs.filter(tx =>
      tx.type === 'create' || tx.to === ''
    );
    console.log(`Found ${deployTxs.length} deployment transactions`);
    
    const deployers = deployTxs.map(tx => web3.utils.toChecksumAddress(tx.from));
    const uniqueDeployers = Array.from(new Set(deployers));
    console.log('Deployers:', uniqueDeployers.map(deployer => getWho(chainLog, deployer)));
    return uniqueDeployers;
  } catch (error) {
    console.error('\nError in getDeployers:', error);
    return [];
  }
}

const isWard = async (contract, suspect) => {
  const ward = await contract.methods.wards(suspect).call();
  return ward != 0;
}

const checkSuspects = async (web3, chainLog, address, suspects) => {
  const who = getWho(chainLog, address);
  const relies = [];
  const abi = getJson('./lib/dss-chain-log/out/ChainLog.abi');
  const contract = new web3.eth.Contract(abi, address);
  const start = new Date();
  let hasWards = true;
  let count = 1;
  for (const suspect of suspects) {
    const progress = Math.floor(100 * count / suspects.length);
    count ++;
    process.stdout.write(`checking wards for ${who}... ${progress}%\r`);
    try {
      const relied = await isWard(contract, suspect);
      if (relied) {
        relies.push(suspect);
      }
    } catch (err) {
      console.log(`checking wards for ${who}... no wards`);
      hasWards = false;
      break;
    }
  }
  const end = new Date();
  const span = Math.floor((end - start) / 1000);
  if (hasWards) {
    console.log(`checking wards for ${who}... found ${relies.length} wards in ${span} seconds`);
  }
  return relies;
}

const getWards = async (env, args, web3, chainLog, address) => {
  let suspects = [];
  const deployers = await getDeployers(env, web3, chainLog, address);
  suspects = suspects.concat(deployers);
  const relies = await getReliesAndKisses(args, web3, chainLog, address);
  suspects = suspects.concat(relies);
  const uniqueSuspects = Array.from(new Set(suspects));
  const wards = await checkSuspects(web3, chainLog, address, uniqueSuspects);
  const allWards = wards.filter(w => w != address);
  return allWards;
}

const getBuds = async (args, web3, chainLog, address) => {
  const buds = [];
  const who = getWho(chainLog, address);
  const kisses = await getReliesAndKisses(args, web3, chainLog, address);
  const abi = getJson('./lib/univ2-lp-oracle/out/UNIV2LPOracle.abi');
  const contract = new web3.eth.Contract(abi, address);
  let hasBuds = true;
  let count = 1;
  const start = new Date();
  for (const kiss of kisses) {
    const progress = Math.floor(100 * count / kisses.length);
    count ++;
    process.stdout.write(`checking buds for ${who}... ${progress}%\r`);
    try {
      const bud = await contract.methods.bud(kiss).call();
      if (bud != 0) {
        buds.push(kiss);
      }
    } catch (err) {
      console.log(`checking buds for ${who}... no buds`);
      hasBuds = false;
      break;
    }
  }
  const end = new Date();
  const span = Math.floor((end - start) / 1000);
  if (hasBuds) {
    console.log(`checking buds for ${who}... found ${kisses.length} buds in ${span} seconds`);
  }
  return buds;
}

const isEoa = async (web3, address) => {
  process.stdout.write('\nchecking if address is externally owned... ');
  const code = await web3.eth.getCode(address);
  const isEoa = ['0x', '0x0'].includes(code);
  console.log(isEoa ? 'yes' : 'no');
  return isEoa;
}

const getAuthorities = async (env, args, web3, chainLog, address) => {
  const who = getWho(chainLog, address);
  if (who !== address) {
    console.log(`\nstarting check for ${who} (${address})`);
  } else {
    console.log(`\nstarting check for address ${address}...`);
  }
  const eoa = await isEoa(web3, address);
  const owner = await getOwner(web3, chainLog, address);
  const authority = await getAuthority(web3, chainLog, address);
  const wards = await getWards(env, args, web3, chainLog, address);
  const buds = await getBuds(args, web3, chainLog, address);
  return { eoa, owner, authority, wards, buds };
}

const cacheLogs = async (args, web3, chainLog, addresses) => {
  const newAddresses = addresses.filter(a => !scannedAddresses.includes(a));
  if (newAddresses.length > 1) {
    console.log();
    allLogs.push(...await getLogs(args, web3, chainLog, newAddresses));
    scannedAddresses.push(...newAddresses);
  }
}

const getGraph = async (env, args, web3, chainLog, address) => {
  const edges = [];
  const vertices = { all: [], current: [], new: [address] };
  let level = 0;
  while (vertices.new.length && level < args.level) {
    level++;
    vertices.current = Array.from(new Set(vertices.new));
    vertices.all.push(...vertices.current);
    vertices.new = [];
    await cacheLogs(args, web3, chainLog, vertices.current);
    for (const target of vertices.current) {
      const authorities = await getAuthorities(env, args, web3, chainLog, target);
      const timestamp = new Date().toISOString();
      if (authorities.eoa) {
        edges.push({ target, source: target, lbl: 'externally owned account', timestamp });
      }
      if (authorities.owner) {
        edges.push({ target, source: authorities.owner, lbl: 'owner', timestamp });
        vertices.new.push(authorities.owner);
      }
      if (authorities.authority) {
        edges.push({ target, source: authorities.authority, lbl: 'authority', timestamp });
        vertices.new.push(authorities.authority);
      }
      for (const ward of authorities.wards) {
        edges.push({ target, source: ward, lbl: 'ward', timestamp });
        vertices.new.push(ward);
      }
      for (const bud of authorities.buds) {
        edges.push({ target, source: bud, lbl: 'bud', timestamp });
        vertices.new.push(bud);
      }
    }
    vertices.new = vertices.new.filter(vertex => !vertices.all.includes(vertex));
  }
  return edges;
}

const getOracleAddresses = async (web3, chainLog) => {
  console.log('getting oracle addresses...\n\n');
  const oracles = [];
  for (const address of Object.keys(chainLog)) {
    const who = chainLog[address];
    if (who.startsWith('PIP_')) {
      console.log(`${who} (${address})`);
      oracles.push(address);
      process.stdout.write('orbs: ');
      const abi = getJson('./lib/univ2-lp-oracle/out/UNIV2LPOracle.abi');
      const contract = new web3.eth.Contract(abi, address);
      try {
        const orb0 = await contract.methods.orb0().call();
        const orb1 = await contract.methods.orb1().call();
        oracles.push(orb0);
        oracles.push(orb1);
        chainLog[orb0] = who + '_ORB0';
        chainLog[orb1] = who + '_ORB1';
        console.log([orb0, orb1], '\n');
      } catch (err) {
        console.log('no orbs');
        process.stdout.write('source: ');
        try {
          const source = await contract.methods.src().call();
          oracles.push(source);
          chainLog[source] = who + '_SRC';
          console.log(source, '\n');
        } catch (err) {
          console.log('no source\n');
        }
      }
    }
  }
  console.log(`found ${oracles.length} oracle addresses`);
  return oracles;
}

const writeResult = (next, type) => {
  const dir = type === 'full' ? 'log' : type;
  let prev;
  try {
    prev = fs.readFileSync(`${dir}/latest.txt`, 'utf8');
  } catch (err) {
    prev = '';
  }
  console.log();
  if (next === prev) {
    console.log(next);
    console.log('no changes since last lookup');
  } else {
    fs.writeFileSync(`${dir}/${new Date().getTime()}.txt`, next);
    fs.writeFileSync(`${dir}/latest.txt`, next);
    console.log(next);
    console.log('changes detected; created new file.');
    console.log('calculating diff, press Ctrl+C to skip');
    const diff = Diff.diffChars(prev, next);
    diff.forEach(part => {
      const text = part.added
            ? chalk.green(part.value)
            : part.removed
            ? chalk.red(part.value)
            : chalk.grey(part.value);
      process.stdout.write(text);
    });
    console.log('\nchanges detected since last lookup');
  }
}

const drawSubTree = (chainLog, graph, parents, root, level, depth) => {
  if (depth && level == depth) return {};
  const subGraph = graph.filter(edge => edge.target === root);
  const subTree = {};
  for (const edge of subGraph) {
    if (parents.includes(edge.source)) continue;
    const who = getWho(chainLog, edge.source);
    const card = `${edge.lbl}: ${who}`;
    subTree[card] = drawSubTree(
      chainLog,
      graph,
      [...parents, root],
      edge.source,
      level + 1,
      depth
    );
  }
  return subTree;
}

const drawReverseSubTree = (chainLog, graph, parents, root, level, depth) => {
  if (depth && level == depth) return {};
  const subGraph = graph.filter(edge => edge.source === root);
  const subTree = {};
  for (const edge of subGraph) {
    if (parents.includes(edge.target)) continue;
    const who = getWho(chainLog, edge.target);
    const card = `${edge.lbl} of ${who}`;
    subTree[card] = drawReverseSubTree(
      chainLog,
      graph,
      [...parents, root],
      edge.target,
      level + 1,
      depth
    );
  }
  return subTree;
}

const drawTree = (chainLog, graph, depth, root) => {
  const who = getWho(chainLog, root);
  const subTree = drawSubTree(chainLog, graph, [], root, 0, depth);
  const tree = who + '\n' + treeify.asTree(subTree);
  return tree;
}

const drawTrees = (chainLog, graph, depth, addresses) => {
  let trees = '';
  for (const address of addresses) {
    const tree = drawTree(chainLog, graph, depth, address)
    trees += tree + '\n';
  }
  return trees;
}

const drawPermissions = (chainLog, graph, depth, root) => {
  const who = getWho(chainLog, root);
  const subTree = drawReverseSubTree(chainLog, graph, [], root, 0, depth);
  const tree = who + '\n' + treeify.asTree(subTree);
  return tree;
}

const readGraph = who => {
  return JSON.parse(fs.readFileSync(`cached/${who}.json`, 'utf8'));
}

const getEdges = graph => {
  const edges = graph.map(edge => edge.source);
  const destinations = graph.map(edge => edge.target);
  edges.push(...destinations);
  const uniqueEdges = Array.from(new Set(edges));
  return uniqueEdges;
}

const writeGraph = (chainLog, name, graph, dir = 'graph') => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(graph));
  const namedGraph = graph.map(edge => {
    return {
      target: getWho(chainLog, edge.target),
      source: getWho(chainLog, edge.source),
      label: edge.lbl,
      timestamp: edge.timestamp // Include timestamp in the output
    };
  });
  let edges = getEdges(namedGraph);
  if (name === 'full') {
    edges.push(...Object.values(chainLog));
    edges = Array.from(new Set(edges));
  }
  const objectEdges = edges.map(edge => { return { id: edge }; });
  const output = { links: namedGraph, nodes: objectEdges };
  fs.writeFileSync(
    `${dir}/${name}.json`,
    JSON.stringify(output, null, 4)
  );
};

const fullMode = async (env, args, web3, chainLog) => {
  console.log('performing full system lookup...');
  const vatAddress = getKey(chainLog, 'MCD_VAT');
  const oracleAddresses = await getOracleAddresses(web3, chainLog);
  const addresses = [vatAddress, ...oracleAddresses];
  let fullGraph;
  if (cached(args).includes('graph')) {
    fullGraph = readGraph('full');
  } else {
    const graph = await getGraphs(env, args, web3, chainLog, addresses);
    const allAddresses = Object.keys(chainLog);
    const edges = getEdges(graph);
    const extra = allAddresses.filter(address => !edges.includes(address));
    const extraGraph = await getGraphs(env, args, web3, chainLog, extra);
    fullGraph = mergeGraphs(graph, extraGraph);
  }
  writeGraph(chainLog, 'full', fullGraph);
  const trees = drawTrees(chainLog, fullGraph, args.level, addresses);
  writeResult(trees, 'full');
}

const mergeGraphs = (a, b) => {
  for (const edge of a) {
    if (!b.find(e => e.source === edge.source
               && e.target === edge.target
               && e.lbl === edge.lbl)
       ) {
      b.push(edge);
    }
  }
  return b;
}

const getGraphs = async (env, args, web3, chainLog, addresses) => {
  await cacheLogs(args, web3, chainLog, addresses);
  let graph = [];
  let count = 0;
  for (const address of addresses) {
    console.log(`\n\naddress ${++count} of ${addresses.length}`);
    const who = getWho(chainLog, address);
    let oracleGraph;
    if (cached(args).includes('graph')) {
      try {
        oracleGraph = readGraph(who);
      } catch (err) {
        console.log('no cached graph found');
        oracleGraph = await getGraph(env, args, web3, chainLog, address);
      }
    } else {
      oracleGraph = await getGraph(env, args, web3, chainLog, address);
      writeGraph(chainLog, who, oracleGraph);
    }
    graph = mergeGraphs(oracleGraph, graph);
  }
  return graph;
}

const oraclesMode = async (env, args, web3, chainLog) => {
  const addresses = await getOracleAddresses(web3, chainLog);
  const graph = await getGraphs(env, args, web3, chainLog, addresses);
  writeGraph(chainLog, 'oracles', graph);
  const trees = drawTrees(chainLog, graph, args.level, addresses);
  writeResult(trees, 'oracles');
}

const parseAddress = (web3, chainLog, contract) => {
  let address;
  if (isAddress(contract)) {
    address = web3.utils.toChecksumAddress(contract);
  } else {
    address = getKey(chainLog, contract);
    if (!address) {
      console.log(chainLog);
      console.log(`'${contract}' isn't an address nor does it exist in the`
                  + ` chainlog.`);
      process.exit();
    }
  }
  return address;
}

const permissionsMode = async (env, args, web3, chainLog, contract) => {
  const address = parseAddress(web3, chainLog, contract);
  const who = getWho(chainLog, address);
  console.log(`performing permissions lookup for ${who}...`);
  const vatAddress = getKey(chainLog, 'MCD_VAT');
  let graph = [];
  if (cached(args).includes('graph')) {
    const vatGraph = readGraph('MCD_VAT');
    const oracleGraph = readGraph('oracles');
    graph = mergeGraphs(graph, oracleGraph);
  } else {
    const vatGraph = await getGraph(env, args, web3, chainLog, vatAddress);
    const oracles = await getOracleAddresses(web3, chainLog);
    const oracleGraph = await getGraphs(env, args, web3, chainLog, oracles);
    graph = mergeGraphs(vatGraph, oracleGraph);
    writeGraph(chainLog, 'MCD_VAT', vatGraph);
    writeGraph(chainLog, 'oracles', oracleGraph);
  }
  const permissions = drawPermissions(chainLog, graph, args.level, address);
  console.log();
  console.log(permissions);
  return permissions;
}

const contractMode = async (env, args, web3, chainLog, contract) => {
  const address = parseAddress(web3, chainLog, contract);
  const who = getWho(chainLog, address);
  let graph;
  if (cached(args).includes('graph')) {
    graph = readGraph(who);
  } else {
    graph = await getGraph(env, args, web3, chainLog, address);
      writeGraph(chainLog, who, graph);
  }
  const tree = drawTree(chainLog, graph, args.level, address);
  console.log();
  console.log(tree);
  return tree;
}

const cached = args => {
  return args.cached ? args.cached : [];
}

const parseArgs = () => {
  const parser = new ArgumentParser({
    description: 'check permissions for DSS'
  });
  parser.add_argument('--mode', '-m', {
    help: 'mode: full, oracles, authorities, permissions',
  });
  parser.add_argument('contracts', {
    help: 'contracts to inspect',
    nargs: '*',
  });
  parser.add_argument('--level', '-l', {
    help: 'maximum depth level for trees',
    default: Infinity,
  });
  parser.add_argument('--cached', '-c', {
    help: 'use cached data',
    choices: ['chainlog', 'logs', 'graph'],
    nargs: '*',
  });
  const args = parser.parse_args();
  if (!args.contracts.length && !args.mode) {
    args.mode = 'full';
  }
  if (!['full', 'oracles'].includes(args.mode) && !args.contracts.length) {
    parser.print_help();
    process.exit();
  }
  return args;
}

const ward = async () => {
  try {
    const env = getEnv();
    const args = parseArgs();
    const web3 = new Web3(env.ETH_RPC_URL);
    const chainLog = await getChainLog(args, web3);
    if (args.mode === 'full') {
      await fullMode(env, args, web3, chainLog);
    } else if (args.mode === 'oracles') {
      await oraclesMode(env, args, web3, chainLog);
    } else {
      if (args.contracts.length > 1) {
        await cacheLogs(args, web3, chainLog, args.contracts);
      }
      let tree = '\n\n\n-----------------------------------\n\n\n';
      for (const contract of args.contracts) {
        const dir = `graph_${contract}`;
        if (args.mode === 'permissions') {
          tree += await permissionsMode(env, args, web3, chainLog, contract);
          tree += '\n\n';
        } else {
          tree += await contractMode(env, args, web3, chainLog, contract);
          tree += '\n\n';
        }
        writeGraph(chainLog, contract, tree, dir);
      }
      console.log(tree);
    }
  } catch (error) {
    console.error('\nFatal error:', error);
    process.exit(1);
  }
}

ward();
