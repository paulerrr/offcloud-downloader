FROM node:20-alpine

# Set working directory
WORKDIR /workspace

# Create required directories
RUN mkdir -p /watch /in-progress /completed /logs

# Set environment variables
ENV NODE_ENV=development
ENV PATH /workspace/node_modules/.bin:$PATH

# Copy package files first (better layer caching)
COPY package.json package-lock.json* /workspace/

# Install dependencies
RUN npm install

# Copy application code
COPY . /workspace

# Set proper permissions
RUN chown -R node:node /workspace /watch /in-progress /completed /logs

# Use non-root user for better security
USER node

# Command
CMD ["npm", "run", "watch"]