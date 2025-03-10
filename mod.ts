import { TarEntry, Untar } from "https://deno.land/std@0.150.0/archive/tar.ts";
import * as streams from "https://deno.land/std@0.150.0/streams/mod.ts";
import * as fs from "https://deno.land/std@0.150.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.150.0/path/mod.ts";

interface NpmVersionlessPackage {
	versions: Record<string, NpmPackage>;
}

interface NpmPackage {
	name: string;
	version: string;
	description: string;
	dist: NpmPackageDist;
	[index: string | number | symbol]: unknown;
}

interface NpmPackageDist {
	tarball: string;
	shasum: string;
	[index: string | number | symbol]: unknown;
}

export interface FetchNpmPackageOptions {
	/** The name of the package to download, such as "rollup".*/
	packageName: string;
	/**
	 * The version of the package to download, such as "2.77.2".
	 * This defaults to "latest" if not specified.
	 */
	version?: string;
}

export interface DownloadNpmPackageOptions extends FetchNpmPackageOptions {
	/**
	 * The file location to download the package to.
	 * This defaults to the ${cwd}/npm_packages/${packageName}/${version}.
	 */
	destination?: string;
	/**
	 * Whether to download the dependencies of the package.json from the package.
	 * These dependencies are placed in a node_modules directory inside the
	 * created `destination` directory.
	 */
	downloadDependencies?: boolean;
	/**
	 * Whether to download the devdependencies of the package.json from the package.
	 * These dependencies are placed in a node_modules directory inside the
	 * created `destination` directory.
	 */
	downloadDevDependencies?: boolean;
}

/**
 * Fetches package distribution information from npm and writes the contents of the package to disk.
 */
export async function downloadNpmPackage({
	packageName,
	version = "latest",
	destination = "",
	downloadDependencies = false,
	downloadDevDependencies = false,
}: DownloadNpmPackageOptions) {
	const fetchedData = await fetchNpmPackage({ packageName, version });
	if (!destination) {
		destination = path.resolve(Deno.cwd(), `./npm_packages/${fetchedData.packageName}/${fetchedData.version}`);
	}
	for await (const entry of fetchedData.getPackageContents()) {
		const destinationPath = path.resolve(destination, entry.fileName);
		if (entry.type == "directory") {
			await fs.ensureDir(destinationPath);
			continue;
		}

		await fs.ensureFile(destinationPath);
		const file = await Deno.open(destinationPath, { write: true });
		await streams.copy(entry, file);
		file.close();
	}

	const needsPackageJson = downloadDependencies || downloadDevDependencies;
	if (needsPackageJson) {
		const packageJsonPath = path.resolve(destination, "package.json");
		const packageJsonStr = await Deno.readTextFile(packageJsonPath);
		const packageJson = JSON.parse(packageJsonStr);
		const nodeModulesPath = path.resolve(destination, "node_modules");
		if (downloadDependencies) {
			await downloadPackageDependencies(packageJson.dependencies || {}, nodeModulesPath);
		}
		if (downloadDevDependencies) {
			await downloadPackageDependencies(packageJson.devDependencies || {}, nodeModulesPath);
		}
	}
}

export interface FetchedNpmPackageData {
	/** The name of the package as returned by the npm registry api */
	packageName: string;
	/** The version of the package as returned by the npm registry api */
	version: string;
	/** Starts downloading the contents of the package. */
	getPackageContents(): AsyncGenerator<TarEntry>;
	/**
	 * The raw registry data as returned by the npm registry api.
	 * The types of this object are incomplete, but this value contains the full
	 * json data from the registry.
	 */
	registryData: NpmPackage;
}

/**
 * Fetches npm package metadata and returns an object that can be used to download the full package.
 */
export async function fetchNpmPackage({
	packageName,
	version = "latest",
}: FetchNpmPackageOptions): Promise<FetchedNpmPackageData> {
	// The registry api doesn't support versions like ^1.0.0, only exact versions
	// or "latest" are supported, so if the specified version is not an exact
	// version, we'll need to download the full package data and find out what
	// the latest valid version is.
	let registryNeedsVersion = false;
	if (version == "latest") {
		registryNeedsVersion = true;
	} else if (version.match(/^[\d\.\s]+$/) && version.split(".").length == 3) {
		registryNeedsVersion = true;
	}

	let errorMessagePackageName: string;
	let url: string;
	if (registryNeedsVersion) {
		url = `https://registry.npmjs.org/${packageName}/${version}`;
		errorMessagePackageName = `${packageName}@${version}`;
	} else {
		url = `https://registry.npmjs.org/${packageName}`;
		errorMessagePackageName = packageName;
	}
	const registryResponse = await fetch(url);
	if (!registryResponse.ok) {
		if (registryResponse.status == 404) {
			throw new Error(
				`Failed to fetch npm package information for "${errorMessagePackageName}" because it doesn't exist.`,
			);
		} else {
			throw new Error(`Failed to fetch npm package information for "${errorMessagePackageName}".`);
		}
	}
	let registryJson: NpmPackage;
	if (registryNeedsVersion) {
		registryJson = await registryResponse.json();
	} else {
		const versionlessPackageJson: NpmVersionlessPackage = await registryResponse.json();
		const versions = Object.keys(versionlessPackageJson.versions);
		const highestVersion = findHighestSemVer(version, versions);
		if (!highestVersion) {
			throw new Error(`Failed to resolve ${packageName}@${version}, version was not found in registry.`);
		}
		registryJson = versionlessPackageJson.versions[highestVersion];
	}

	return {
		packageName,
		version: registryJson.version,
		registryData: registryJson,
		async *getPackageContents() {
			const dist = registryJson.dist;
			const tarResponse = await fetch(dist.tarball);
			if (!tarResponse.ok) {
				throw new Error(
					`Failed to fetch ${packageName}@${version}, ${url} responded with an invalid status code: ${tarResponse.status}`,
				);
			}

			// Verify the shasum
			{
				const tarBlob = await tarResponse.clone().blob();
				const tarArrayBuffer = await tarBlob.arrayBuffer();
				const digestedSum = await crypto.subtle.digest("SHA-1", tarArrayBuffer);
				const hashArray = Array.from(new Uint8Array(digestedSum));
				const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
				if (hashHex !== dist.shasum) {
					throw new Error(`Failed to fetch ${packageName}@${version}, checksum failed`);
				}
			}

			if (!tarResponse.body) {
				throw new Error("Assertion failed, response body is null.");
			}

			const streamReader = tarResponse.body.pipeThrough(new DecompressionStream("gzip")).getReader();
			const untar = new Untar(streams.readerFromStreamReader(streamReader));

			for await (const entry of untar) {
				// Strip package/ from the beginning of the path.
				entry.fileName = entry.fileName.replace(/^package\//, "");
				yield entry;
			}
		},
	};
}

/**
 * Splits a string such as "@rollup/plugin-alias@4.0.2" into a name string: "@rollup/plugin-alias" and version: "4.0.2".
 */
export function splitNameAndVersion(nameAndVersion: string) {
	if (!nameAndVersion) {
		throw new Error("The provided string is empty");
	}
	const index = nameAndVersion.lastIndexOf("@");
	if (index == -1) {
		throw new Error("The provided string contains no version");
	}
	const packageName = nameAndVersion.slice(0, index);
	const version = nameAndVersion.slice(index + 1);
	if (!packageName) {
		throw new Error("The provided string contains no package name");
	}
	if (!version) {
		throw new Error("The provided string contains no version");
	}
	return {
		packageName,
		version,
	};
}

async function downloadPackageDependencies(depencencies: Record<string, string>, destination: string) {
	for (const [packageName, version] of Object.entries(depencencies)) {
		await downloadNpmPackage({
			packageName,
			version,
			destination: path.resolve(destination, packageName),
			downloadDependencies: true,
		});
	}
}

/**
 * Finds the highest version from `versionList` that matches `version`.
 */
function findHighestSemVer(version: string, versionList: string[]) {
	let highestMajor = 0;
	let highestMinor = 0;
	let highestPatch = 0;
	let highestVersion = null;
	for (const packageVersion of versionList) {
		if (!semVerMatches(version, packageVersion)) continue;

		const [major, minor, patch] = parsePackageVersion(packageVersion);
		let isHighest = false;
		if (major > highestMajor) {
			isHighest = true;
		} else if (major == highestMajor) {
			if (minor > highestMinor) {
				isHighest = true;
			} else if (minor == highestMinor) {
				if (patch > highestPatch) {
					isHighest = true;
				}
			}
		}
		if (isHighest) {
			highestMajor = major;
			highestMinor = minor;
			highestPatch = patch;
			highestVersion = packageVersion;
		}
	}
	return highestVersion;
}

function semVerMatches(version: string, packageVersion: string) {
	let needsExactMajor = true;
	let needsExactMinor = true;
	let needsExactPatch = true;
	version = version.trim();
	const versionPartLength = version.split(".").filter((p) => p.match(/\d+/)).length;
	if (["x", "X", "*"].includes(version)) {
		needsExactMajor = false;
		needsExactMinor = false;
		needsExactPatch = false;
	}
	if (version.startsWith("^") || versionPartLength == 1) {
		needsExactMinor = false;
		needsExactPatch = false;
	}
	if (version.startsWith("~") || versionPartLength == 2) {
		needsExactPatch = false;
	}
	const [major, minor, patch] = parsePackageVersion(version);
	const [packageMajor, packageMinor, packagePatch] = parsePackageVersion(packageVersion);
	if (needsExactMajor && major != packageMajor) return false;
	if (needsExactMinor && minor != packageMinor) return false;
	if (needsExactPatch && patch != packagePatch) return false;
	return true;
}

function parsePackageVersion(packageVersion: string) {
	packageVersion = packageVersion.replaceAll("~", "");
	packageVersion = packageVersion.replaceAll("^", "");
	packageVersion = packageVersion.replaceAll("x", "0");
	packageVersion = packageVersion.replaceAll("X", "0");
	packageVersion = packageVersion.replaceAll("*", "0");
	const [majorStr, minorStr, patchStr] = packageVersion.split(".");
	let major = parseInt(majorStr, 10);
	let minor = parseInt(minorStr, 10);
	let patch = parseInt(patchStr, 10);
	if (isNaN(major)) major = 0;
	if (isNaN(minor)) minor = 0;
	if (isNaN(patch)) patch = 0;
	return [major, minor, patch];
}
