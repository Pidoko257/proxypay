import fs from "fs";
import path from "path";

export type DependencyCategory =
  | "payment_provider"
  | "cryptography"
  | "cloud_infrastructure"
  | "database_cache"
  | "network_http"
  | "runtime_utility";

export interface DependencyEntry {
  name: string;
  version: string;
  category: DependencyCategory;
  direct: boolean;
  type: "production" | "development" | "transitive";
  integrity?: string;
  resolved?: string;
}

export interface DependencyInventory {
  generatedAt: string;
  totalDirect: number;
  totalTransitive: number;
  totalPackages: number;
  categories: Record<DependencyCategory, number>;
  directProduction: DependencyEntry[];
  directDevelopment: DependencyEntry[];
  transitive: DependencyEntry[];
}

export function classifyDependency(name: string): DependencyCategory {
  const lower = name.toLowerCase();
  if (
    lower.includes("stellar") ||
    lower.includes("soroban") ||
    lower.includes("stripe") ||
    lower.includes("payment") ||
    lower.includes("momo") ||
    lower.includes("paypal") ||
    lower.includes("orange") ||
    lower.includes("mtn")
  ) {
    return "payment_provider";
  }

  if (
    lower.includes("crypto") ||
    lower.includes("bcrypt") ||
    lower.includes("argon") ||
    lower.includes("jwt") ||
    lower.includes("jsonwebtoken") ||
    lower.includes("sodium") ||
    lower.includes("elliptic") ||
    lower.includes("vault") ||
    lower.includes("secret")
  ) {
    return "cryptography";
  }

  if (
    lower.startsWith("@aws-sdk") ||
    lower.startsWith("@google-cloud") ||
    lower.startsWith("@azure") ||
    lower.includes("docker") ||
    lower.includes("kubernetes")
  ) {
    return "cloud_infrastructure";
  }

  if (
    lower.includes("pg") ||
    lower.includes("postgres") ||
    lower.includes("redis") ||
    lower.includes("ioredis") ||
    lower.includes("knex") ||
    lower.includes("typeorm") ||
    lower.includes("prisma")
  ) {
    return "database_cache";
  }

  if (
    lower.includes("express") ||
    lower.includes("axios") ||
    lower.includes("fetch") ||
    lower.includes("got") ||
    lower.includes("http") ||
    lower.includes("ws") ||
    lower.includes("graphql")
  ) {
    return "network_http";
  }

  return "runtime_utility";
}

export function generateDependencyInventory(
  projectRoot: string = process.cwd()
): DependencyInventory {
  const pkgPath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  let lock: any = null;
  if (fs.existsSync(lockPath)) {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  }

  const prodDeps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  const directProdEntries: DependencyEntry[] = Object.keys(prodDeps)
    .sort()
    .map((name) => ({
      name,
      version: prodDeps[name],
      category: classifyDependency(name),
      direct: true,
      type: "production",
    }));

  const directDevEntries: DependencyEntry[] = Object.keys(devDeps)
    .sort()
    .map((name) => ({
      name,
      version: devDeps[name],
      category: classifyDependency(name),
      direct: true,
      type: "development",
    }));

  const directSet = new Set([...Object.keys(prodDeps), ...Object.keys(devDeps)]);
  const transitiveEntries: DependencyEntry[] = [];

  if (lock && lock.packages) {
    for (const [pkgKey, pkgData] of Object.entries<any>(lock.packages)) {
      if (!pkgKey || pkgKey === "") continue;
      const cleanName = pkgKey.replace(/^node_modules\//, "");
      if (!cleanName.includes("node_modules") && !directSet.has(cleanName)) {
        transitiveEntries.push({
          name: cleanName,
          version: pkgData.version || "unknown",
          category: classifyDependency(cleanName),
          direct: false,
          type: "transitive",
          integrity: pkgData.integrity,
          resolved: pkgData.resolved,
        });
      }
    }
  }

  transitiveEntries.sort((a, b) => a.name.localeCompare(b.name));

  const allEntries = [...directProdEntries, ...directDevEntries, ...transitiveEntries];
  const categories: Record<DependencyCategory, number> = {
    payment_provider: 0,
    cryptography: 0,
    cloud_infrastructure: 0,
    database_cache: 0,
    network_http: 0,
    runtime_utility: 0,
  };

  for (const entry of allEntries) {
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalDirect: directProdEntries.length + directDevEntries.length,
    totalTransitive: transitiveEntries.length,
    totalPackages: allEntries.length,
    categories,
    directProduction: directProdEntries,
    directDevelopment: directDevEntries,
    transitive: transitiveEntries,
  };
}

export function formatInventoryMarkdown(inventory: DependencyInventory): string {
  let md = `# ProxyPay Dependency Inventory & Release Review\n\n`;
  md += `Generated at: ${inventory.generatedAt}\n\n`;
  md += `## Summary Metrics\n\n`;
  md += `- **Total Direct Dependencies**: ${inventory.totalDirect}\n`;
  md += `- **Production Dependencies**: ${inventory.directProduction.length}\n`;
  md += `- **Development Dependencies**: ${inventory.directDevelopment.length}\n`;
  md += `- **Transitive Dependencies**: ${inventory.totalTransitive}\n`;
  md += `- **Total Tracked Packages**: ${inventory.totalPackages}\n\n`;

  md += `## Breakdown by Category\n\n`;
  md += `| Category | Package Count |\n`;
  md += `| :--- | :--- |\n`;
  for (const [cat, count] of Object.entries(inventory.categories)) {
    md += `| \`${cat}\` | ${count} |\n`;
  }
  md += `\n`;

  md += `## Direct Production Dependencies\n\n`;
  md += `| Package | Version Spec | Category |\n`;
  md += `| :--- | :--- | :--- |\n`;
  for (const dep of inventory.directProduction) {
    md += `| \`${dep.name}\` | \`${dep.version}\` | \`${dep.category}\` |\n`;
  }
  md += `\n`;

  return md;
}

if (require.main === module) {
  const inventory = generateDependencyInventory();
  const outputPath = path.join(process.cwd(), "docs", "DEPENDENCY_INVENTORY.md");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, formatInventoryMarkdown(inventory), "utf-8");
  console.log(`Generated dependency inventory with ${inventory.totalPackages} packages at ${outputPath}`);
}
