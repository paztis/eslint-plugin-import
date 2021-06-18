import path from 'path';
import fs from 'fs';
import readPkgUp from 'read-pkg-up';
import minimatch from 'minimatch';
import resolve from 'eslint-module-utils/resolve';
import moduleVisitor from 'eslint-module-utils/moduleVisitor';
import importType from '../core/importType';
import { getFilePackageName } from '../core/packagePath';
import docsUrl from '../docsUrl';

const depFieldCache = new Map();

function hasKeys(obj = {}) {
  return Object.keys(obj).length > 0;
}

function arrayOrKeys(arrayOrObject) {
  return Array.isArray(arrayOrObject) ? arrayOrObject : Object.keys(arrayOrObject);
}

function extractDepFields(pkg) {
  return {
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
    peerDependencies: pkg.peerDependencies || {},
    // BundledDeps should be in the form of an array, but object notation is also supported by
    // `npm`, so we convert it to an array if it is an object
    bundledDependencies: arrayOrKeys(pkg.bundleDependencies || pkg.bundledDependencies || []),
  };
}

function getDependencies(context, packageDir) {
  let paths = [];
  try {
    const packageContent = {
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
      bundledDependencies: [],
    };

    if (packageDir && packageDir.length > 0) {
      if (!Array.isArray(packageDir)) {
        paths = [path.resolve(packageDir)];
      } else {
        paths = packageDir.map(dir => path.resolve(dir));
      }
    }

    if (paths.length > 0) {
      // use rule config to find package.json
      paths.forEach(dir => {
        const packageJsonPath = path.join(dir, 'package.json');
        if (!depFieldCache.has(packageJsonPath)) {
          const depFields = extractDepFields(
            JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
          );
          depFieldCache.set(packageJsonPath, depFields);
        }
        const _packageContent = depFieldCache.get(packageJsonPath);
        Object.keys(packageContent).forEach(depsKey =>
          Object.assign(packageContent[depsKey], _packageContent[depsKey])
        );
      });
    } else {
      // use closest package.json
      Object.assign(
        packageContent,
        extractDepFields(
          readPkgUp.sync({ cwd: context.getFilename(), normalize: false }).pkg
        )
      );
    }

    if (![
      packageContent.dependencies,
      packageContent.devDependencies,
      packageContent.optionalDependencies,
      packageContent.peerDependencies,
      packageContent.bundledDependencies,
    ].some(hasKeys)) {
      return null;
    }

    return packageContent;
  } catch (e) {
    if (paths.length > 0 && e.code === 'ENOENT') {
      context.report({
        message: 'The package.json file could not be found.',
        loc: { line: 0, column: 0 },
      });
    }
    if (e.name === 'JSONError' || e instanceof SyntaxError) {
      context.report({
        message: 'The package.json file could not be parsed: ' + e.message,
        loc: { line: 0, column: 0 },
      });
    }

    return null;
  }
}

function missingErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies. ` +
    `Run 'npm i -S ${packageName}' to add it`;
}

function devDepErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies, not devDependencies.`;
}

function optDepErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies, ` +
    `not optionalDependencies.`;
}

function getModuleOriginalName(name) {
  const [first, second] = name.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

function getModuleRealName(resolved) {
  return getFilePackageName(resolved);
}

function checkDependencyDeclaration(deps, packageName) {
  // in case of sub package.json inside a module
  // check the dependencies on all hierarchy
  const packageHierarchy = [];
  const packageNameParts = packageName.split('/');
  packageNameParts.forEach((namePart, index) => {
    if (!namePart.startsWith('@')) {
      const ancestor = packageNameParts.slice(0, index + 1).join('/');
      packageHierarchy.push(ancestor);
    }
  });

  return packageHierarchy.reduce((result, ancestorName) => {
    return {
      isInDeps: result.isInDeps || deps.dependencies[ancestorName] !== undefined,
      isInDevDeps: result.isInDevDeps || deps.devDependencies[ancestorName] !== undefined,
      isInOptDeps: result.isInOptDeps || deps.optionalDependencies[ancestorName] !== undefined,
      isInPeerDeps: result.isInPeerDeps || deps.peerDependencies[ancestorName] !== undefined,
      isInBundledDeps:
        result.isInBundledDeps || deps.bundledDependencies.indexOf(ancestorName) !== -1,
    };
  }, {
    isInDeps: false,
    isInDevDeps: false,
    isInOptDeps: false,
    isInPeerDeps: false,
    isInBundledDeps: false,
  });
}

function reportIfMissing(context, deps, depsOptions, node, name) {
  // Do not report when importing types
  if (node.importKind === 'type' || (node.parent && node.parent.importKind === 'type') || node.importKind === 'typeof') {
    return;
  }

  if (importType(name, context) !== 'external') {
    return;
  }

  const resolved = resolve(name, context);
  if (!resolved) { return; }

  const importPackageName = getModuleOriginalName(name);
  const importPackageNameDeclaration = checkDependencyDeclaration(deps, importPackageName);

  if (importPackageNameDeclaration.isInDeps ||
    (depsOptions.allowDevDeps && importPackageNameDeclaration.isInDevDeps) ||
    (depsOptions.allowPeerDeps && importPackageNameDeclaration.isInPeerDeps) ||
    (depsOptions.allowOptDeps && importPackageNameDeclaration.isInOptDeps) ||
    (depsOptions.allowBundledDeps && importPackageNameDeclaration.isInBundledDeps)
  ) {
    return;
  }

  // test the real name from the resolved package.json
  // if not aliased imports (alias/react for example), importPackageName can be  misinterpreted
  const realPackageName = getModuleRealName(resolved);

  if(!realPackageName){
    throw new Error(`cant find real package name for import ${name}`);
  }

  const realPackageNameDeclaration = checkDependencyDeclaration(deps, realPackageName);



  if (realPackageNameDeclaration.isInDeps ||
    (depsOptions.allowDevDeps && realPackageNameDeclaration.isInDevDeps) ||
    (depsOptions.allowPeerDeps && realPackageNameDeclaration.isInPeerDeps) ||
    (depsOptions.allowOptDeps && realPackageNameDeclaration.isInOptDeps) ||
    (depsOptions.allowBundledDeps && realPackageNameDeclaration.isInBundledDeps)
  ) {
    return;
  }

  if ((
    importPackageNameDeclaration.isInDevDeps ||
    realPackageNameDeclaration.isInDevDeps
  ) && !depsOptions.allowDevDeps) {
    context.report(node, devDepErrorMessage(realPackageName));
    return;
  }

  if ((
    importPackageNameDeclaration.isInOptDeps ||
    realPackageNameDeclaration.isInOptDeps
  ) && !depsOptions.allowOptDeps) {
    context.report(node, optDepErrorMessage(realPackageName));
    return;
  }

  context.report(node, missingErrorMessage(realPackageName));
}

function testConfig(config, filename) {
  // Simplest configuration first, either a boolean or nothing.
  if (typeof config === 'boolean' || typeof config === 'undefined') {
    return config;
  }
  // Array of globs.
  return config.some(c => (
    minimatch(filename, c) ||
    minimatch(filename, path.join(process.cwd(), c))
  ));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      url: docsUrl('no-extraneous-dependencies'),
    },

    schema: [
      {
        'type': 'object',
        'properties': {
          'devDependencies': { 'type': ['boolean', 'array'] },
          'optionalDependencies': { 'type': ['boolean', 'array'] },
          'peerDependencies': { 'type': ['boolean', 'array'] },
          'bundledDependencies': { 'type': ['boolean', 'array'] },
          'packageDir': { 'type': ['string', 'array'] },
        },
        'additionalProperties': false,
      },
    ],
  },

  create: function (context) {
    const options = context.options[0] || {};
    const filename = context.getFilename();
    const deps = getDependencies(context, options.packageDir) || extractDepFields({});

    const depsOptions = {
      allowDevDeps: testConfig(options.devDependencies, filename) !== false,
      allowOptDeps: testConfig(options.optionalDependencies, filename) !== false,
      allowPeerDeps: testConfig(options.peerDependencies, filename) !== false,
      allowBundledDeps: testConfig(options.bundledDependencies, filename) !== false,
    };

    return moduleVisitor((source, node) => {
      reportIfMissing(context, deps, depsOptions, node, source.value);
    }, { commonjs: true });
  },
};
