#!/usr/bin/env node
import { buildCLI } from "./cli";

const program = buildCLI();
program.parse(process.argv);
