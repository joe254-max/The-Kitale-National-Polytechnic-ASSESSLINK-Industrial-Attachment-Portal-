import * as serverless from 'serverless-http';
import { app } from '../server';

const handler = ((serverless as any).default || serverless)(app);
export default handler;
