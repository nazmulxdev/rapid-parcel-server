import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );

    // starting crud operation
    const dataBase = client.db("rapidParcelDb");
    const parcelCollection = dataBase.collection("parcels");

    // parcels api get
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;

        const query = email ? { senderEmail: email } : {};
        const options = {
          sort: { creation_date: -1 }, // latest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("🚨 Failed to fetch parcels:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // post api for stored parcel details
    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;
        const result = await parcelCollection.insertOne(parcelData);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel " });
      }
    });

    // delete parcel from api
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Delete failed" });
      }
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Rapid Parcel server is running");
});
app.listen(port, () => {
  console.log("This server is running on port", port);
});
