import { readFile } from 'node:fs/promises';
import { buildWalkingGraph } from '../src/routing/index.js';
import { ScenarioRunner } from './simulator.js';
const graph=buildWalkingGraph(JSON.parse(await readFile(new URL('../public/cornell-osm.json',import.meta.url),'utf8')));
const runner=new ScenarioRunner(graph);let passed=true;
for(const scenario of ['A','B','C','D']){const result=runner.run(scenario);console.log(JSON.stringify(result,null,2));passed&&=result.passed;}
runner.dispose();process.exitCode=passed?0:1;
