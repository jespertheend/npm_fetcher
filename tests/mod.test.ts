import { assertEquals } from "https://deno.land/std@0.167.0/testing/asserts.ts";
import { assertSpyCall, assertSpyCalls, spy } from "https://deno.land/std@0.167.0/testing/mock.ts";
import { downloadNpmPackage, fetchNpmPackage } from "../mod.ts";

Deno.test({
	name: "Fetch package data",
	async fn() {
		const packageData = await fetchNpmPackage({
			packageName: "rollup-plugin-resolve-url-objects",
			version: "0.0.4",
		});
		assertEquals(packageData.packageName, "rollup-plugin-resolve-url-objects");
		assertEquals(packageData.version, "0.0.4");
		assertEquals(packageData.registryData.name, "rollup-plugin-resolve-url-objects");

		const fileNames: string[] = [];
		for await (const entry of packageData.getPackageContents()) {
			fileNames.push(entry.fileName);
		}
		fileNames.sort();
		assertEquals(fileNames, ["LICENSE", "README.md", "main.js", "package.json"]);
	},
});

Deno.test({
	name: "Download and save package data",
	async fn() {
		const dirPath = await Deno.makeTempDir();
		const cwd = Deno.cwd();

		try {
			Deno.chdir(dirPath);
			Deno.mkdir("tmp");

			const downloadPromise = downloadNpmPackage({
				packageName: "rollup-plugin-resolve-url-objects",
				version: "0.0.4",
				destination: dirPath,
			});

			// Change into another directory to verify that the files are downloaded
			// into the initial directory.
			Deno.chdir("tmp");

			await downloadPromise;

			const fileNames: string[] = [];
			for await (const entry of Deno.readDir(dirPath)) {
				fileNames.push(entry.name);
			}
			fileNames.sort();
			assertEquals(fileNames, ["LICENSE", "README.md", "main.js", "package.json", "tmp"]);
		} finally {
			Deno.chdir(cwd); // https://github.com/denoland/deno/issues/15849
			await Deno.remove(dirPath, { recursive: true });
		}
	},
});

Deno.test({
	name: "Fetch without getting any files",
	async fn() {
		const fetchSpy = spy(globalThis, "fetch");

		try {
			const packageData = await fetchNpmPackage({
				packageName: "rollup-plugin-resolve-url-objects",
				version: "0.0.4",
			});
			assertEquals(packageData.packageName, "rollup-plugin-resolve-url-objects");
			assertEquals(packageData.version, "0.0.4");
			assertEquals(packageData.registryData.name, "rollup-plugin-resolve-url-objects");
			assertSpyCalls(fetchSpy, 1);
			assertSpyCall(fetchSpy, 0, {
				args: ["https://registry.npmjs.org/rollup-plugin-resolve-url-objects/0.0.4"],
			});
		} finally {
			fetchSpy.restore();
		}
	},
});
