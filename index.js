import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import Stripe from "stripe";

// this is required import
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.pAYMENT_GATEWAY_kEY);

// add origin url and set app into cookie parser
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

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
    // starting crud operation
    const dataBase = client.db("rapidParcelDb");
    const parcelCollection = dataBase.collection("parcels");
    const paymentsCollection = dataBase.collection("payments");
    const trackingCollection = dataBase.collection("tracking");
    const usersCollection = dataBase.collection("users");
    const ridersCollection = dataBase.collection("riders");

    // custom middleware

    // token verifier

    const verifyToken = (req, res, next) => {
      const token = req?.cookies?.token;
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      jwt.verify(token, process.env.JWT_SECRET, (error, decoded) => {
        if (error) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    // verify admin

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden access - admin only" });
      }
      next();
    };

    // verify rider
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user?.role !== "rider") {
        return res
          .status(403)
          .send({ message: "Forbidden access - rider only" });
      }
      next();
    };

    // jwt token related api

    // mounting token in the cookie
    app.post("/validation", async (req, res) => {
      const { email } = req.body;
      const user = { email };
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });
      // send to cookie
      res.cookie("token", token, {
        httpOnly: true,
        secure: false,
      });
      // send response
      res.send({ success: true });
    });

    // unmounting cookies after logout user
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
      });
      res.status(200).send({ message: "Logged out, cookie cleared" });
    });
    // users collection

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      const currentTime = new Date().toISOString();
      if (userExists) {
        // update last login info
        const updateLastLog = await usersCollection.updateOne(
          { email },
          {
            $set: {
              last_log_in: currentTime,
            },
          },
        );

        return res.status(200).send({
          message: "user already exist",
          inserted: false,
          result: updateLastLog,
        });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // get all paid undelivered parcel
    app.get(
      "/parcels/assignable",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcels = await parcelCollection
            .find({
              payment_status: "paid",
              delivery_status: "pending",
            })
            .sort({ creation_date: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to load assignable parcels" });
        }
      },
    );

    // rider task

    app.get("/rider/tasks", verifyToken, verifyRider, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        // match parcels where rider is assigned and status is pending (in progress)
        const query = {
          assigned_rider_email: email,
          delivery_status: { $in: ["assigned", "in_transit"] },
        };

        const parcels = await parcelCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("❌ Failed to get rider tasks:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // get completed deliveries for a rider
    app.get(
      "/rider/completed-parcels",
      verifyToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;

          if (!email) {
            return res
              .status(400)
              .send({ message: "Rider email is required." });
          }

          const completedStatuses = ["delivered", "service_center_delivered"];
          const query = {
            assigned_rider_email: email,
            delivery_status: { $in: completedStatuses },
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ creation_date: -1 }) // newest first
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("❌ Error fetching completed rider parcels:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      },
    );

    // Rider requests cashout for a completed delivery
    app.patch(
      "/rider/cashOut/:parcelId",
      verifyToken,
      verifyRider,
      async (req, res) => {
        try {
          const { parcelId } = req.params;
          const { rider_earned } = req.body;

          // Step 1: Validate ObjectId
          if (!ObjectId.isValid(parcelId)) {
            return res.status(400).send({ message: "Invalid Parcel ID" });
          }

          // Step 2: Find the parcel
          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(parcelId),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          // Step 3: Only allow cashout for delivered parcels
          const allowedStatuses = ["delivered", "service_center_delivered"];
          if (!allowedStatuses.includes(parcel.delivery_status)) {
            return res
              .status(400)
              .send({ message: "Parcel is not eligible for cashout" });
          }

          // Step 4: Prevent duplicate requests
          if (parcel.cashout_status && parcel.cashout_status !== "none") {
            return res
              .status(409)
              .send({ message: "Cashout already requested or paid" });
          }

          rider_earned = Number(rider_earned);

          if (isNaN(rider_earned)) {
            return res
              .status(400)
              .send({ message: "rider_earned must be a valid number" });
          }

          // Step 5: Update parcel with cashout status
          const result = await parcelCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                rider_earned: rider_earned,
                cashout_status: "requested",
                cashout_requested_at: new Date(),
              },
            },
          );

          res.send({
            message: "Cashout requested successfully 💸",
            result,
          });
        } catch (error) {
          console.error("❌ Cashout request error:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      },
    );

    // rider route to change the parcel status
    app.patch(
      "/parcels/:id/status",
      verifyToken,
      verifyRider,
      async (req, res) => {
        const { id } = req.params;
        const { delivery_status } = req.body;

        if (!["in_transit", "delivered"].includes(delivery_status)) {
          return res.status(400).send({ message: "Invalid status update" });
        }

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { delivery_status } },
        );

        res.send(result);
      },
    );

    // get requested delivered parcels by rider
    app.get("/admin/cashouts", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { status } = req.query;

        const completedStatuses = ["delivered", "service_center_delivered"];
        const query = {
          cashout_status: status,
          delivery_status: { $in: completedStatuses },
        };

        const parcels = await parcelCollection
          .find(query)
          .sort({ cashout_requested_at: -1 }) // newest first
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("❌ Error fetching completed rider parcels:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // confirm riders payment by admin
    app.patch(
      "/admin/cashOut/:parcelId",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { parcelId } = req.params;
          const { confirmed_by } = req.body;

          if (!ObjectId.isValid(parcelId)) {
            return res.status(400).send({ message: "Invalid Parcel ID" });
          }

          // Ensure admin name/email is provided
          if (!confirmed_by) {
            return res
              .status(400)
              .send({ message: "Admin identifier is required." });
          }

          // Step 1: Find the parcel
          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(parcelId),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          // Step 2: Check if already paid
          if (parcel.cashout_status === "paid") {
            return res
              .status(409)
              .send({ message: "Cashout already marked as paid" });
          }

          // Step 3: Update the parcel
          const updateDoc = {
            $set: {
              cashout_status: "paid",
              cashout_paid_at: new Date(),
              cashout_confirmed_by: confirmed_by,
            },
          };

          const result = await parcelCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            updateDoc,
          );

          res.send({
            message: "Cashout marked as paid ✅",
            result,
          });
        } catch (error) {
          console.error("❌ Error confirming rider cashout:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      },
    );

    //assign rider to delivery parcel
    app.patch(
      "/parcels/:id/assign",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { riderEmail, riderName } = req.body;

        if (!riderEmail || !riderName) {
          return res.status(400).send({ message: "Rider info is required" });
        }

        try {
          const result = await parcelCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                assigned_rider_email: riderEmail,
                assigned_rider_name: riderName,
                delivery_status: "assigned",
              },
            },
          );

          res.send({ message: "Rider assigned successfully", result });
        } catch (err) {
          console.error("❌ Failed to assign rider:", err);
          res.status(500).send({ message: "Failed to assign rider" });
        }
      },
    );

    // admin route
    app.get("/users/search", verifyToken, verifyAdmin, async (req, res) => {
      const { query } = req.query;

      if (!query) {
        return res.status(400).send({ message: "Search query is required." });
      }

      try {
        const users = await usersCollection
          .find({
            $or: [
              { name: { $regex: query, $options: "i" } },
              { email: { $regex: query, $options: "i" } },
            ],
          })
          .project({
            name: 1,
            email: 1,
            role: 1,
            created_at: 1,
            last_log_in: 1,
          })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("❌ Failed to search users:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // role change api PATCH /users/:id/role

    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;

      if (!role || !["admin", "user", "rider"].includes(role)) {
        return res.status(400).send({ message: "Invalid role provided" });
      }

      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } },
        );

        if (result.modifiedCount > 0) {
          res.send({ message: `User role updated to ${role}`, result });
        } else {
          res
            .status(404)
            .send({ message: "User not found or already has that role" });
        }
      } catch (error) {
        console.error("❌ Failed to update user role:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // get role of user by email

    app.get("/users/role/:email", async (req, res) => {
      const { email } = req.params;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      try {
        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } }, // only return the role field
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role });
      } catch (error) {
        console.error("❌ Error getting user role:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // all   riders who applied for

    app.post("/riders", verifyToken, async (req, res) => {
      try {
        const { email } = req.body;
        // checking rider email
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }
        // checking is the rider data is existed in the database
        const existingRider = await ridersCollection.findOne({ email });
        if (existingRider) {
          return res.status(409).send({
            message: "User has already applied as a rider",
            alreadyApplied: true,
          });
        }

        const riderInfo = req.body;
        const result = await ridersCollection.insertOne(riderInfo);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // get all rider whose are pending status
    app.get("/riders/pending", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .sort({ appliedAt: -1 }) // latest first
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        console.error("❌ Error fetching pending riders:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // update raiders status or accept or reject raider
    // app.patch("/riders/:id", async (req, res) => {
    //   const { id } = req.params;
    //   const { status } = req.body;

    //   const result = await ridersCollection.updateOne(
    //     { _id: new ObjectId(id) },
    //     { $set: { status } },
    //   );

    //   res.send(result);
    // });

    //PATCH for rider status update (accept, reject, deactivate, etc.)
    app.patch("/riders/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;

      if (!status) {
        return res.status(400).send({ message: "Status is required." });
      }

      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: { status },
      };

      try {
        const result = await ridersCollection.updateOne(query, updatedDoc);

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Rider not found or already status has updated" });
        }

        // update user role from accepting rider
        let roleResult = null;
        if (status === "active" && email) {
          const userQuery = { email };
          const userUpdatedDoc = {
            $set: {
              role: "rider",
            },
          };
          roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdatedDoc,
          );
        }

        res.send({
          message: "Rider status updated",
          riderUpdated: result,
          userRoleUpdate: roleResult,
        });
      } catch (error) {
        console.error("🚨 Error updating rider status:", error);
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    // get all active riders

    app.get("/riders/active", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const search = req.query.search || "";
        const query = {
          status: "active",
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        };

        const activeRiders = await ridersCollection
          .find(query)
          .sort({ appliedAt: -1 })
          .toArray();

        res.send(activeRiders);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // admin control to deactivate rider

    // app.patch("/riders/:id", async (req, res) => {
    //   const { id } = req.params;
    //   const { status } = req.body;

    //   try {
    //     const result = await ridersCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { status } },
    //     );

    //     res.send(result);
    //   } catch (error) {
    //     res.status(500).send({ message: "Failed to update status" });
    //   }
    // });

    // parcels api get
    app.get("/parcels", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }
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

    // get method for specific parcel by id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.status(200).send(parcel);
      } catch (error) {
        console.error("❌ Failed to fetch parcel by ID:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // record payment history and update parcel status

    app.post("/payments", async (req, res) => {
      try {
        const {
          parcelId,
          userEmail,
          amount,
          transactionId,
          paymentIntentId,
          paymentMethod,
          cardBrand,
          cardLast4,
        } = req.body;

        if (
          !parcelId ||
          !transactionId ||
          !userEmail ||
          !amount ||
          !paymentMethod
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        // 🔍 1. Check if parcel already paid
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        if (parcel.payment_status === "paid") {
          return res.status(400).send({ message: "Parcel is already paid" });
        }

        // ✅ 2. Update parcel status
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
              transaction_id: transactionId,
              payment_method: paymentMethod,
            },
          },
        );

        // 🧾 3. Save payment record
        const paymentDoc = {
          parcelId,
          userEmail,
          amount,
          transactionId,
          paymentIntentId,
          paymentMethod,
          cardBrand,
          cardLast4,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const result = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          success: true,
          message: "Payment recorded and parcel marked as paid",
          paymentId: result.insertedId,
        });
      } catch (error) {
        console.error("❌ Payment processing failed:", error);
        res.status(500).send({ message: "Something went wrong" });
      }
    });

    // adding tracking payment of the parcel
    // app.post("/tracking", async (req, res) => {
    //   try {
    //     const {
    //       parcelId,
    //       tracking_id,
    //       status,
    //       location,
    //       updated_by,
    //     } = req.body;

    //     if (!parcelId || !tracking_id || !status || !location || !updated_by) {
    //       return res.status(400).send({ message: "Missing required fields" });
    //     }

    //     const update = {
    //       parcelId,
    //       tracking_id,
    //       status,
    //       location,
    //       updated_by,
    //       updated_at: new Date(),
    //     };

    //     const result = await trackingCollection.insertOne(update);

    //     res.send({
    //       success: true,
    //       message: "Tracking update saved",
    //       insertedId: result.insertedId,
    //     });
    //   } catch (err) {
    //     console.error("❌ Failed to add tracking:", err);
    //     res.status(500).send({ message: "Internal Server Error" });
    //   }
    // });

    // GET: Get all tracking updates by tracking ID
    // app.get("/tracking/:tracking_id", async (req, res) => {
    //   try {
    //     const { tracking_id } = req.params;

    //     const updates = await trackingCollection
    //       .find({ tracking_id })
    //       .sort({ updated_at: 1 }) // oldest to newest
    //       .toArray();

    //     if (updates.length === 0) {
    //       return res.status(404).send({ message: "No tracking updates found" });
    //     }

    //     res.send(updates);
    //   } catch (err) {
    //     console.error("❌ Failed to get tracking info:", err);
    //     res.status(500).send({ message: "Internal Server Error" });
    //   }
    // });

    // Get all tracking updates by parcelId
    // app.get("/tracking/:parcelId", async (req, res) => {
    //   try {
    //     const parcelId = req.params.parcelId;
    //     const trackingUpdates = await trackingCollection
    //       .find({ parcelId })
    //       .sort({ updated_at: 1 })
    //       .toArray();

    //     res.send(trackingUpdates);
    //   } catch (error) {
    //     console.error("❌ Tracking fetch error:", error);
    //     res.status(500).send({ message: "Failed to get tracking updates" });
    //   }
    // });
    // get payment history by email

    app.get("/myPayments", verifyToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const userPayments = await paymentsCollection
          .find({ userEmail: email })
          .sort({ paid_at: -1 })
          .toArray();

        res.send(userPayments);
      } catch (error) {
        console.error("❌ Fetch user payments failed:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // stripe payment system
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body;

        if (!amount) {
          return res.status(400).send({ message: "Amount is required" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount * 100, // convert to cents if using USD
          currency: "usd", // or "bdt", "eur", etc.
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("🔥 Stripe error:", error);
        res.status(500).send({ message: "Stripe payment creation failed" });
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
