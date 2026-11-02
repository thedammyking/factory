// Test target for starter.yaml (`semgrep --test semgrep/`): `ruleid:` marks the next line as a required hit, `ok:` as a
// required miss.
import express from "express";
import Fastify from "fastify";

const app = express();

app.post("/users", async (req, res) => {
  // ruleid: factory-mass-assignment
  const user = await prisma.user.create({ data: req.body });
  // ruleid: factory-mass-assignment
  await prisma.user.update({ where: { id: req.params.id }, data: { ...req.body, updatedBy: req.user.id } });
  // ruleid: factory-mass-assignment
  await this.prisma.post.upsert({ where: { id }, create: req.body, update: { title: req.body.title } });
  // ok: factory-mass-assignment
  await prisma.user.create({ data: { name: req.body.name, email: req.body.email } });
  // ok: factory-mass-assignment
  await prisma.user.create({ data: CreateUser.parse(req.body) });
  res.json(user);
});

app.put("/items/:id", async (req, res) => {
  // ruleid: factory-mass-assignment
  await db.insert(items).values(req.body);
  // ruleid: factory-mass-assignment
  await db.update(items).set(request.body).where(eq(items.id, id));
  // ruleid: factory-mass-assignment
  await Item.findByIdAndUpdate(req.params.id, req.body, { new: true });
  // ruleid: factory-mass-assignment
  await Item.create(ctx.request.body);
  // ok: factory-mass-assignment
  await Item.create({ name: req.body.name });
  const item = await repo.findOneBy({ id: req.params.id });
  // ruleid: factory-mass-assignment
  Object.assign(item, req.body);
  // ok: factory-mass-assignment
  const copy = Object.assign({}, req.body);
  // ok: factory-mass-assignment
  res.json(req.body);
});

export async function createPost(formData: FormData) {
  "use server";
  // ruleid: factory-mass-assignment
  await prisma.post.create({ data: Object.fromEntries(formData) });
}

export async function POST(req: Request) {
  const body = await req.json();
  // ruleid: factory-mass-assignment-parsed-body
  const post = await prisma.post.create({ data: body });
  // ok: factory-mass-assignment-parsed-body
  await prisma.post.update({ where: { id: post.id }, data: { title: body.title } });
  return Response.json(post);
}

export async function PATCH(request: Request) {
  const input = Schema.parse(await request.json());
  // ok: factory-mass-assignment-parsed-body
  return Response.json(await prisma.post.update({ where: { id: input.id }, data: input }));
}

export async function sync() {
  const data = await upstream.json();
  // ok: factory-mass-assignment-parsed-body
  await prisma.snapshot.create({ data });
}

// ruleid: factory-trust-proxy-all
app.set("trust proxy", true);
// ruleid: factory-trust-proxy-all
app.enable("trust proxy");
// ruleid: factory-trust-proxy-all
const fastify = Fastify({ logger: true, trustProxy: true });
// ok: factory-trust-proxy-all
app.set("trust proxy", 1);

app.use((err, req, res, next) => {
  // ruleid: factory-stack-trace-in-response
  res.status(500).json({ error: err.message, stack: err.stack });
});

export function onError(e: Error) {
  // ruleid: factory-stack-trace-in-response
  return new Response(e.stack, { status: 500 });
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  // ok: factory-stack-trace-in-response
  res.status(500).json({ error: "Something went wrong", stack: process.env.NODE_ENV === "development" ? err.stack : undefined });
});
