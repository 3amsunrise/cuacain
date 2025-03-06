export default function handler(req, res) {
  res.status(200).json({ key: process.env.OWM_API_KEY });
}