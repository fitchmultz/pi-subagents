import { inventory, declarationPattern } from "./inventory.ts";
import { compilerFiles } from "./compiler.ts";

const root = process.cwd();
const declarations = inventory(root).filter((file) => declarationPattern.test(file));
if (declarations.length > 0) {
  process.stdout.write(compilerFiles(root, declarations, "declarations"));
  console.log(
    `Declaration check: ${declarations.length} handwritten files and their dependency closure checked with skipLibCheck:false.`,
  );
} else {
  console.log("Declaration check: no handwritten declarations.");
}
