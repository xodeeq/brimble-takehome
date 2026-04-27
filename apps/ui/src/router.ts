import { createRootRoute, createRoute } from '@tanstack/react-router';
import { IndexPage } from './routes/index';

const rootRoute = createRootRoute();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexPage,
});

export const routeTree = rootRoute.addChildren([indexRoute]);
