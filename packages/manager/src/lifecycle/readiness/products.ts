type Product = "inference" | "training";
type Runner<T extends string> = (target: T, args: string[]) => string;

const probe =
	"fetch(process.argv[1]).then(async response=>{if(!response.ok)throw new Error(`${response.status} ${await response.text()}`)}).catch(error=>{console.error(error.message);process.exit(1)})";

export function verifyProductReadiness(
	product: Product,
	run: Runner<Product>,
) {
	const port = product === "inference" ? 4770 : 4780;
	run(product, [
		"exec",
		"-T",
		"api",
		"node",
		"-e",
		probe,
		`http://127.0.0.1:${port}/readyz`,
	]);
}

export function verifyLabReadiness(run: (args: string[]) => string) {
	run([
		"exec",
		"-T",
		"controller",
		"node",
		"-e",
		probe,
		"http://127.0.0.1:8080/readyz",
	]);
}
