import { buildServer } from "./app.js";

/** Boot entrypoint: build the server and bind it to localhost. */
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = buildServer();

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`DataStack One backend listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
