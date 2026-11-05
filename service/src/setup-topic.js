import { PubSub } from '@google-cloud/pubsub';
const projectId = process.env.GCP_PROJECT_ID || 'local-event-analytics';
const topicId = process.env.PUBSUB_TOPIC_ID || 'app-events';
const pubsub = new PubSub({ projectId });
const topic = pubsub.topic(topicId);
const [exists] = await topic.exists();
if (!exists) await pubsub.createTopic(topicId);
console.log(`Topic ready: ${topicId} (${projectId})`);
