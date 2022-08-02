import { Untar } from "https://deno.land/std@0.150.0/archive/tar.ts";
import * as streams from "https://deno.land/std@0.150.0/streams/mod.ts";
import * as fs from "https://deno.land/std@0.150.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.150.0/path/mod.ts";

interface NpmPackageDist {
	tarball: string;
	shasum: string;
}

interface NpmPackage {
	name: string;
	version: string;
	description: string;
	dist: NpmPackageDist;
}

export interface DownloadNpmPackageOptions {
	/** The name of the package to download, such as "rollup".*/
	packageName: string;
	/**
	 * The version of the package to download, such as "2.77.2".
	 * This defaults to "latest" if not specified.
	 */
	version?: string;
	/**
	 * The file location to download the package to.
	 * This defaults to the ${cwd}/npm_packages/${packageName}/${version}.
	 */
	destination?: string;
}

/**
 * Fetches package distribution information from npm.
 */
export async function downloadNpmPackage({
	packageName,
	version = "latest",
	destination = "",
}: DownloadNpmPackageOptions) {
	const url = `https://registry.npmjs.org/${packageName}/${version}`;
	const packageResponse = await fetch(url);
	const packageJson: NpmPackage = await packageResponse.json();
	const dist = packageJson.dist;
	if (!destination) {
		destination = path.resolve(Deno.cwd(), `./npm_packages/${packageName}/${packageJson.version}`);
	}
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
		if (!entry.fileName.startsWith("package/")) {
			throw new Error(`Assertion failed, "${entry.fileName}" is not in the package directory.`);
		}
		const entryPath = entry.fileName.substring("package/".length);

		const destinationPath = path.resolve(destination, entryPath);
		if (entry.type == "directory") {
			await fs.ensureDir(destinationPath);
			continue;
		}

		await fs.ensureFile(destinationPath);
		const file = await Deno.open(destinationPath, { write: true });
		await streams.copy(entry, file);
	}
}
